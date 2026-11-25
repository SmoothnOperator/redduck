// Merkle tree utilities for the airdrop. Uses double-hashed leaves
// (`keccak256(keccak256(encodePacked(account, amount)))`), sorted-pair internal
// nodes, and odd-node promotion so trees, roots, and proofs match MerkleAirdrop.sol.

import { keccak256, encodePacked, concat, type Address, type Hex } from "viem";

export interface AirdropEntry {
  account: Address;
  amount: bigint;
}

// Hash one airdrop entry into a second-preimage-resistant leaf.
export function hashLeaf(entry: AirdropEntry): Hex {
  const inner = keccak256(encodePacked(["address", "uint256"], [entry.account, entry.amount]));
  return keccak256(inner);
}

function hashPair(a: Hex, b: Hex): Hex {
  return a.toLowerCase() <= b.toLowerCase() ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}

export class MerkleTree {
  layers: Hex[][];

  constructor(entries: AirdropEntry[]) {
    if (entries.length === 0) {
      throw new Error("MerkleTree: cannot build tree with zero entries");
    }

    const leaves = entries.map(hashLeaf);
    this.layers = [leaves];

    let currentLayer = leaves;
    while (currentLayer.length > 1) {
      const nextLayer: Hex[] = [];
      for (let i = 0; i < currentLayer.length; i += 2) {
        if (i + 1 < currentLayer.length) {
          nextLayer.push(hashPair(currentLayer[i], currentLayer[i + 1]));
        } else {
          // Odd-layer convention: promote the unpaired node directly to the next layer
          nextLayer.push(currentLayer[i]);
        }
      }
      this.layers.push(nextLayer);
      currentLayer = nextLayer;
    }
  }

  get root(): Hex {
    return this.layers[this.layers.length - 1][0];
  }

  // The sibling hashes from the leaf at `index` up to the root.
  getProof(index: number): Hex[] {
    if (index < 0 || index >= this.layers[0].length) {
      throw new Error(`MerkleTree: index ${index} out of bounds`);
    }

    const proof: Hex[] = [];
    let currentIndex = index;

    for (let layerIdx = 0; layerIdx < this.layers.length - 1; layerIdx++) {
      const layer = this.layers[layerIdx];
      const siblingIndex = currentIndex % 2 === 0 ? currentIndex + 1 : currentIndex - 1;

      if (siblingIndex < layer.length) {
        proof.push(layer[siblingIndex]);
      }

      currentIndex = Math.floor(currentIndex / 2);
    }

    return proof;
  }
}
