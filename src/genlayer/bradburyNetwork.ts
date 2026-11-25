import { createClient } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";
import type { Account } from "viem";

// The intelligent-contract node and the underlying Orbit chain have different RPCs.
export const bradburyEndpoint = "https://rpc.bradbury.genlayer.com";
export const orbitEndpoint = testnetBradbury.rpcUrls.default.http[0];

// Orbit handles fees, broadcasts and consensus receipts. GenVM executes views and reads schemas.
export function createBradburyClient(account?: Account) {
  const consensus = createClient({ chain: testnetBradbury, account });
  const node = createClient({ chain: testnetBradbury, endpoint: bradburyEndpoint });
  return { ...consensus, getContractSchemaForCode: node.getContractSchemaForCode,
    getContractSchema: node.getContractSchema, readContract: node.readContract, getContractCode: node.getContractCode };
}

// genlayer-networks/bradbury-phase-3, consensus v0.6.0. Phase 2 shares the same rollup.
export const bradburyDeployment = {
  chainId: 4221,
  genesis: "0x17d89764d4f4f963158fc4c5e8f2cb670c2837740b35f37081c12860c3df97e4",
  manager: "0x0192c6c9482251790965b7136352b26234d81d79",
  consensus: "0x0f4f0e05475723790e4a2ed0598370783c300926",
  data: "0x2247b85b7ca7fb1fea990b4afab4328d9c597f28",
} as const;

export const juryFeeOptions = {
  leaderTimeunitsAllocation: 130n,
  validatorTimeunitsAllocation: 230n,
  executionBudgetPerRound: 10n ** 18n,
  appealRounds: 0n,
  rotations: [0n],
  totalMessageFees: 0n,
};
export const depositCeiling = 3n * 10n ** 18n;

export async function deploymentFees(client: ReturnType<typeof createClient>) {
  if (!client.chain.isStudio && !client.chain.feeManagerContract) return;
  const estimate = await client.estimateTransactionFees(juryFeeOptions);
  if (!estimate.policy.enabled) return;
  if (estimate.feeValue > depositCeiling) throw new Error("Quoted jury deposit exceeds 3 GEN");
  return estimate;
}
