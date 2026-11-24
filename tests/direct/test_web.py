import hashlib
import json
import pytest
from .conftest import model_reply

URL = "https://records.genlayer.com/receipt"
PAGE = "Payment ABC completed on 21 November for 27 units."


def deploy(deploy_contract, urls):
    return deploy_contract("contracts/acp_evaluator.py", "Check the cited receipt", URL,
                           "Verify the payment using the cited page.",
                           json.dumps({"web": {"domains": ["records.genlayer.com"], "urls": urls}}))


def mock_judge(vm, quote):
    vm.mock_web(URL, {"body": PAGE})
    vm.mock_llm("Payment ABC completed on 21 November", model_reply({
        "score": 90, "confidence": 88, "reasoning": "The dated receipt confirms payment.",
        "citations": [{"url": URL, "quote": quote}]}))


def test_judges_read_and_bind_the_same_page(direct_vm, direct_deploy):
    mock_judge(direct_vm, PAGE)
    contract = deploy(direct_deploy, [URL])
    ruling = contract.get_result()
    assert ruling["verdict"] == "approve", ruling
    assert PAGE in ruling["reasoning"]
    assert contract.get_web_evidence() == {URL: hashlib.sha256(PAGE.encode()).hexdigest()}
    assert direct_vm.run_validator()
    direct_vm.clear_mocks()
    direct_vm.mock_web(URL, {"body": PAGE + " Later updated."})
    direct_vm.mock_llm("Later updated", model_reply({"score": 90, "confidence": 88,
                       "reasoning": "Same verdict", "citations": [{"url": URL, "quote": PAGE}]}))
    assert not direct_vm.run_validator()


def test_unsubstantiated_quote_withholds_verdict(direct_vm, direct_deploy):
    mock_judge(direct_vm, "Paid a million")
    assert deploy(direct_deploy, [URL]).get_result()["verdict"] == "needs_review"


@pytest.mark.parametrize("urls", [[], [URL] * 4, ["https://different.org/"], [URL]])
def test_missing_or_unreadable_sources_withhold_verdict(direct_vm, direct_deploy, urls):
    if urls == [URL]:
        direct_vm.mock_web(URL, {"body": ""})
    result = deploy(direct_deploy, urls).get_result()
    assert result["verdict"] == "needs_review", result
