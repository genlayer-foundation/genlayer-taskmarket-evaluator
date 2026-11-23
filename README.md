# Internet Court evaluator for Taskmarket

[Internet Court × Taskmarket](https://d1t95mbzk50y2b.cloudfront.net/) · [Explore completed evaluations](https://d1t95mbzk50y2b.cloudfront.net/explorer?venue=taskmarket)

Internet Court checks public work against agreed milestone rubrics. A requester names its Tempo evaluator wallet when opening a claim task. The worker submits public text artifacts. The evaluator verifies the submission, obtains a finalized GenLayer Bradbury ruling for each agreed milestone, and relays the award to Taskmarket. The ledger records the recipient and amount after verifying a successful settlement receipt and the OUSD transfer.

## Verified testnet pilot · 23 November 2026

The requester escrowed 1 test OUSD and named the evaluator by address. Bradbury finalized an approval with a score of 92/100. After Taskmarket's five-minute window, Tempo block 45,574,489 recorded transfers of **0.95 OUSD to the worker** and **0.05 OUSD to the evaluator**. The published service is limited to Tempo Moderato. A separate requester found it under Research with a 5% fee and 24-hour evaluation window.

[Taskmarket job](https://testnet-market.daydreams.systems/tasks/0xd0343e6fcec85dc7d78d394b05381260ac37ad6e67b6b23fc9c69dadf4ed3278) · [Finalized Bradbury ruling](https://scan.bradbury.genlayer.com/tx/0x1cfcd1c1ffd6b1e7ce6c007d9161ebc9b1b4714f885ff8aa43b2dbd4ca2f64d4) · [Tempo settlement](https://explore.testnet.tempo.xyz/tx/0x13b63d78b57f4155d3f0c4af68697020f243a82bc4b7e63b29755e6f410eff66) · [Evaluator listing](https://testnet-market.daydreams.systems/agents/0x1380a30dc76b58580101e240b80c25134944b20f) · [Full public evidence record](examples/taskmarket/settled-pilot.json)

## Run the local demo

Use Node 22.13 or newer. From the repository root run

```sh
npm ci
npm --prefix dashboard ci
npm run demo
```

Open [the local ledger](http://127.0.0.1:4731). The demo seeds approval, rejection, a 30-of-50 OUSD award, and recovery after a lost verdict response. Choose **Needs review** to see the evaluator withhold a verdict. Example judgments and receipts are simulated. The demo uses the same award calculation, journal and settlement state machine as the live worker.

## Run a job by address on the test networks

1. Create independent Taskmarket identities for the requester, worker and evaluator. Each command stores its wallet and device credentials under its own directory in `data/pilot/`. The CLI prompts if the selected network requires legal acceptance.

   ```sh
   scripts/pilot-wallet evaluator init
   scripts/pilot-wallet requester init
   scripts/pilot-wallet worker init
   npm run taskmarket:evaluator -- prepare-signer
   ```

2. Fund the printed **Bradbury** address with 3 test GEN for the one-milestone pilot. The GEN covers the consensus deposit and transaction fee. The requester needs 1 test OUSD for escrow, and each Tempo wallet should have test OUSD for action fees. With Foundry installed, obtain Tempo test funds for each public wallet from its faucet. Repeat the address lookup, faucet request and balance check for each role.

   ```sh
   scripts/pilot-wallet requester address
   cast rpc tempo_fundAddress <public-Tempo-address> --rpc-url https://rpc.moderato.tempo.xyz
   scripts/pilot-wallet requester wallet balance
   npm run taskmarket:evaluator -- preflight
   ```

   Preflight checks Tempo Moderato chain 42431, Taskmarket revision 31, its token and evaluator functions, and the Bradbury Phase 2 genesis, consensus contract, contract schema and fee quote. The official Bradbury faucet has owner eligibility requirements. Test GEN can also come from an existing Bradbury test wallet. [Bradbury faucet](https://testnet-faucet.genlayer.foundation/) · [Taskmarket network identity](https://docs.taskmarket.dev/identity/agent-registration)

3. Run the first job. This command makes public testnet writes and spends the fixed 1 test OUSD escrow when the Bradbury deposit is covered.

   ```sh
   npm run taskmarket:evaluator -- pilot
   ```

   The command reserves a public claim for the pilot worker, assigns the evaluator **by wallet address**, posts the exact [agreement](examples/taskmarket/fixed.json), and uploads the [worker's guide](examples/taskmarket/submission.md). It allows 24 hours for evaluation and uses the onchain minimum Taskmarket appeal window (five minutes on the verified deployment). It prints the task ID at creation and the verified record on settlement. Rerun the command in the same checkout after an interruption to resume the same job. The evaluator's fee is 0.05 test OUSD. A passing guide earns 0.95. A rejection refunds 0.95 to the requester. Test wallets are operated by the same pilot operator.

4. Open the live ledger in another terminal.

   ```sh
   npm run build
   npm --prefix dashboard run build
   npm start
   ```

   Open [the testnet ledger](http://127.0.0.1:3000). Each job has a JSON record at `/evaluations/<task-id>`. Demo and testnet use separate databases.

## Evaluate a buyer's task

The buyer puts the complete agreed JSON in the task description. The service supports public single-worker claim tasks with zero platform fee, no stake, and no award-transforming hook. It accepts UTF-8 plain text, Markdown, CSV and JSON, up to 48 KiB per submission. Each milestone has a price in millionths of OUSD. The prices together equal escrow less the evaluator fee. The [research agreement](examples/taskmarket/research.json) prices the comparison at 30 and the reproducible procedures at 20, with a zero fee.

Enroll an agreed task explicitly and run one worker per journal.

```sh
npm run taskmarket:evaluator -- track <task-id> examples/taskmarket/fixed.json
npm run taskmarket:evaluator -- work
npm run taskmarket:evaluator -- show <task-id>
```

For recurring buyers, set `TASKMARKET_ACCEPT_BRIEF` to the agreed JSON path and `TASKMARKET_ACCEPT_REQUESTERS` to the comma-separated approved buyer addresses before starting `work`. The worker reads the evaluator's public Taskmarket inbox, enrolls matching assignments and verifies their terms on both the public API and Tempo. Other buyers can arrange enrollment by task ID. `once` advances the existing journal once.

### What the receipt proves

- The evidence record binds the Tempo chain, marketplace contract, task, requester, worker, submission event, exact manifest bytes, and hashes of the public artifacts. Each Bradbury contract records its inputs and ruling. Only a successful finalized deployment whose stored inputs match can contribute to an award.
- A milestone receives its full agreed amount on approval and zero on rejection. A score of 40–69 or an unsuccessful judgment withholds the verdict for operator review. A temporary outage leaves the work eligible for retry. An expired evaluation returns to Taskmarket's timeout process.
- The operator-controlled evaluator wallet relays the verdict. The evidence hash commits to the inputs, rulings and award. Today buyers trust that operator to relay faithfully. A pending Taskmarket appeal passes to the assigned resolver. Only an eligible worker can appeal, and only when the requester named a resolver. The fixed pilot leaves the resolver unset.
- The ledger marks a job settled after finding both its marketplace completion or cancellation event and the matching OUSD transfer from escrow. A finalized GenLayer ruling or an issued verdict alone leaves the payment pending.
- The SQLite journal saves signed Bradbury transactions before broadcast and uses stable Taskmarket write keys. Keep `data/` private and on persistent storage. Stop the worker and ledger before copying the directory as a backup. It contains wallet credentials, recoverable signed transactions and the journal.

### A future permissionless relay

Bradbury finality and Taskmarket settlement have independent clocks. A future cross-chain adapter could accept an authenticated message containing the finalized ruling, task ID, evidence hash, worker and award. A sender on the GenLayer side must attest finality, and the Tempo receiver must bind the message to the agreed task and consume it once. Hyperlane can transport that message with a configured route and security module. Taskmarket revision 31 restricts verdict submission to trusted forwarders and its V2 forwarder restricts the relayer. Removing the operator's discretion requires an authorized contract integration with Taskmarket or a different escrow that accepts such proofs. [Hyperlane Mailbox](https://docs.hyperlane.xyz/docs/protocol/core/mailbox) · [EvaluatorFacet](https://github.com/daydreamsai/taskmarket-contracts/blob/94d124c8051c593e5e40f872ad77de6149eb048b/evm/src/facets/EvaluatorFacet.sol#L113-L132) · [Forwarder](https://github.com/daydreamsai/taskmarket-contracts/blob/94d124c8051c593e5e40f872ad77de6149eb048b/evm/src/TaskMarketForwarderV2.sol#L131)

## Publish an evaluator listing after a verified settlement

The profile and service can be published directly through Taskmarket. Use the evaluator wallet that appeared on the successful job. Check existing services before adding one. A pilot listing can be limited to Tempo testnet.

```sh
scripts/pilot-wallet evaluator agent listing
scripts/pilot-wallet evaluator agent profile set --name "Internet Court" \
  --role evaluator --specialty "Research" \
  --description "Internet Court gives buyers and workers a decision they can both check. Independent GenLayer validators assess the same public submission against the rubric agreed before work starts. Each milestone has a price, so completed work can earn a partial payout. Verify the final ruling on GenLayer and the payment on Tempo. Explore completed evaluations or enroll a testnet task at https://d1t95mbzk50y2b.cloudfront.net/"
scripts/pilot-wallet evaluator agent service add --kind evaluation \
  --title "Internet Court research review" --specialty "Research" \
  --description "For research reports and technical guides, agree on the rubric and price each milestone before posting. Independent GenLayer validators check the same submitted text. Both parties can read the reasons for each ruling and verify the resulting payment or refund on Tempo testnet. Arrange enrollment before posting." \
  --deliverable "A reasoned ruling for each milestone and a Tempo settlement receipt showing the amount paid or refunded." \
  --fee-bps 500 --evaluation-window 24 --chain tempo-testnet
scripts/pilot-wallet evaluator agents evaluators --specialty "Research"
```

Buyers can then use `--evaluator-from-listing <evaluator-address>` or choose a listed evaluator in Taskmarket. Tempo mainnet needs its own chain registration, funded operator accounts and a separate mainnet deployment configuration. The implementation in this fork is pinned to the two test networks. Visa verification and Visa CLI discovery are separate from Taskmarket registration and are untested in this pilot. [Taskmarket directory](https://docs.taskmarket.dev/hiring/directory) · [Evaluator and appeal rules](https://docs.taskmarket.dev/reference/evaluators)

## Foundation hosting

The testnet worker runs in Foundation Apps on a private EC2 host. Operators can enroll a task, open the ledger and restore its journal through the [hosting guide](deploy/aws/README.md).

## Validation

```sh
npm run build
npm test
npm --prefix dashboard run build
python3 -m pip install -r requirements-test.txt
GENVM_VERSION=v0.6.0-rc10 genvm-lint check contracts/acp_evaluator.py
GENVM_VERSION=v0.6.0-rc10 gltest tests/direct/ -q
```

This project is a fork of the [Virtuals ACP evaluator](https://github.com/genlayerlabs/genlayer-acp-evaluator). Its original integration remains available through `npm run start:acp`.
