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


@pytest.mark.parametrize("score, expected", [(48, "reject"), (69, "reject"), (70, "approve")])
def test_pass_fail_policy_has_no_middle_band(direct_vm, direct_deploy, score, expected):
    direct_vm.mock_llm("pass/fail milestone", model_reply({
        "score": score, "confidence": 97, "reasoning": "The jury compared the evidence with the terms."
    }))
    contract = direct_deploy("contracts/acp_evaluator.py", "Verify a payout", "Evidence", "Prove payment",
                             json.dumps({"decision_policy": "pass-fail"}))
    assert contract.get_result()["verdict"] == expected
    assert direct_vm.run_validator()


@pytest.mark.parametrize("scenario, expected, success", [
    ("missing", "reject", True), ("overflow", "reject", True), ("unreadable", "error", False),
    ("unverified-quote", "error", False), ("inconclusive", "reject", True)
])
def test_web_pass_fail_separates_missing_proof_from_evaluator_failure(direct_vm, direct_deploy, scenario, expected, success):
    urls = [] if scenario == "missing" else [URL] * 4 if scenario == "overflow" else [URL]
    if scenario == "unreadable":
        direct_vm.mock_web(URL, {"body": ""})
    elif scenario in ("inconclusive", "unverified-quote"):
        direct_vm.mock_web(URL, {"body": "Escrow funded."})
        direct_vm.mock_llm("Escrow funded", model_reply({
            "score": 48, "confidence": 97, "reasoning": "Escrow funding does not prove a payout.",
            "citations": [{"url": URL, "quote": "Escrow funded." if scenario == "inconclusive" else "Not on the page"}]
        }))
    contract = direct_deploy("contracts/acp_evaluator.py", "Check the payout", URL, "Prove payment",
        json.dumps({"decision_policy": "pass-fail", "web": {"domains": ["records.genlayer.com"], "urls": urls}}))
    result = contract.get_result()
    assert (result["verdict"], result["success"]) == (expected, success), result
    assert direct_vm.run_validator()
