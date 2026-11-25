// Signing helper for claimWithSignature. Binds the signature to chainId,
// the specific MerkleAirdrop contract address, the claimant address, and amount,
// matching MerkleAirdrop.claimWithSignature() using EIP-191 personal_sign.

import {
  encodeAbiParameters,
  keccak256,
  parseSignature,
  type WalletClient,
  type Address,
} from "viem";

export interface ClaimSignatureParts {
  v: number;
  r: `0x${string}`;
  s: `0x${string}`;
}

export async function signAirdropClaim(
  signerWallet: WalletClient,
  claimant: Address,
  amount: bigint,
  contractAddress: Address,
  chainId: bigint,
): Promise<ClaimSignatureParts> {
  if (!signerWallet.account) {
    throw new Error("signAirdropClaim: signerWallet has no account");
  }

  const digest = keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "address" }, { type: "uint256" }],
      [chainId, contractAddress, claimant, amount],
    ),
  );

  const signatureHex = await signerWallet.signMessage({
    account: signerWallet.account,
    message: { raw: digest },
  });

  const parsed = parseSignature(signatureHex);
  const v = Number(parsed.v ?? (parsed.yParity === 0 ? 27 : 28));

  return {
    v,
    r: parsed.r,
    s: parsed.s,
  };
}
