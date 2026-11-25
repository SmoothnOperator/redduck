import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseEther, getAddress, zeroHash } from "viem";
import { MerkleTree, type AirdropEntry } from "./merkle.ts";
import { signAirdropClaim } from "./signatures.ts";

const { viem, networkHelpers } = await network.connect();

const SECP256K1_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

describe("MerkleAirdrop", function () {
  async function deployFixture() {
    const [deployer, alice, bob, carol, signer, dave, eve] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();
    const chainId = BigInt(await publicClient.getChainId());

    const entries: AirdropEntry[] = [
      { account: getAddress(alice.account.address), amount: parseEther("100") },
      { account: getAddress(bob.account.address), amount: parseEther("200") },
      { account: getAddress(carol.account.address), amount: parseEther("300") },
      { account: getAddress(eve.account.address), amount: parseEther("50") },
    ];
    const tree = new MerkleTree(entries);

    const token = await viem.deployContract("Token", [
      "Redduck Token",
      "RDDK",
      parseEther("100000000000000"),
    ]);
    const airdrop = await viem.deployContract("MerkleAirdrop", [
      token.address,
      tree.root,
      signer.account.address,
    ]);

    await token.write.transfer([airdrop.address, parseEther("100000000000000")], {
      account: deployer.account,
    });

    return {
      entries,
      tree,
      token,
      airdrop,
      chainId,
      deployer,
      alice,
      bob,
      carol,
      signer,
      dave,
      eve,
    };
  }

  it("lets an eligible account claim its allocation with a Merkle proof", async function () {
    const { entries, tree, token, airdrop, alice } =
      await networkHelpers.loadFixture(deployFixture);

    const proof = tree.getProof(0);
    const { account, amount } = entries[0];

    await viem.assertions.emitWithArgs(
      airdrop.write.claim([amount, proof], { account: alice.account }),
      airdrop,
      "Claimed",
      [account, amount],
    );

    assert.equal((await token.read.balanceOf([account])) as bigint, amount);
    assert.equal((await airdrop.read.hasClaimed([account])) as boolean, true);
  });

  it("lets an authorized account claim with an admin signature (not on the Merkle list)", async function () {
    const { token, airdrop, chainId, signer, dave } =
      await networkHelpers.loadFixture(deployFixture);

    const daveAddr = getAddress(dave.account.address);
    const amount = parseEther("50");

    const { v, r, s } = await signAirdropClaim(signer, daveAddr, amount, airdrop.address, chainId);

    await viem.assertions.emitWithArgs(
      airdrop.write.claimWithSignature([amount, v, r, s], { account: dave.account }),
      airdrop,
      "Claimed",
      [daveAddr, amount],
    );

    assert.equal((await token.read.balanceOf([daveAddr])) as bigint, amount);
    assert.equal((await airdrop.read.hasClaimed([daveAddr])) as boolean, true);
  });

  describe("Merkle tree odd-layer and proof failure modes", function () {
    it("verifies proofs for an odd-sized Merkle tree (3 entries)", async function () {
      const [deployer, alice, bob, carol, signer] = await viem.getWalletClients();
      const entries: AirdropEntry[] = [
        { account: getAddress(alice.account.address), amount: parseEther("10") },
        { account: getAddress(bob.account.address), amount: parseEther("20") },
        { account: getAddress(carol.account.address), amount: parseEther("30") },
      ];
      const oddTree = new MerkleTree(entries);
      const token = await viem.deployContract("Token", ["Odd", "ODD", parseEther("1000")]);
      const airdrop = await viem.deployContract("MerkleAirdrop", [
        token.address,
        oddTree.root,
        signer.account.address,
      ]);
      await token.write.transfer([airdrop.address, parseEther("1000")], {
        account: deployer.account,
      });

      // Carol is at index 2 (promoted odd node in layer 0)
      await airdrop.write.claim([entries[2].amount, oddTree.getProof(2)], {
        account: carol.account,
      });
      assert.equal(await token.read.balanceOf([carol.account.address]), parseEther("30"));
    });

    it("reverts InvalidProof for wrong amount, wrong caller, corrupted proof, or non-member", async function () {
      const { entries, tree, airdrop, alice, bob, dave } =
        await networkHelpers.loadFixture(deployFixture);

      const aliceProof = tree.getProof(0);

      // Wrong amount
      await assert.rejects(
        airdrop.write.claim([entries[0].amount + 1n, aliceProof], { account: alice.account }),
        /InvalidProof/,
      );

      // Wrong caller using Alice's proof
      await assert.rejects(
        airdrop.write.claim([entries[0].amount, aliceProof], { account: bob.account }),
        /InvalidProof/,
      );

      // Corrupted proof element
      const badProof = [...aliceProof];
      badProof[0] = zeroHash;
      await assert.rejects(
        airdrop.write.claim([entries[0].amount, badProof], { account: alice.account }),
        /InvalidProof/,
      );

      // Non-member (dave) with empty proof
      await assert.rejects(
        airdrop.write.claim([parseEther("50"), []], { account: dave.account }),
        /InvalidProof/,
      );
    });
  });

  describe("signature failure modes and replay protection", function () {
    it("reverts InvalidSignature when signed by a non-admin wallet", async function () {
      const { airdrop, chainId, alice, dave } = await networkHelpers.loadFixture(deployFixture);
      const daveAddr = getAddress(dave.account.address);
      const amount = parseEther("50");

      const { v, r, s } = await signAirdropClaim(alice, daveAddr, amount, airdrop.address, chainId);

      await assert.rejects(
        airdrop.write.claimWithSignature([amount, v, r, s], { account: dave.account }),
        /InvalidSignature/,
      );
    });

    it("reverts InvalidSignature when amount does not match signed amount", async function () {
      const { airdrop, chainId, signer, dave } = await networkHelpers.loadFixture(deployFixture);
      const daveAddr = getAddress(dave.account.address);
      const amount = parseEther("50");

      const { v, r, s } = await signAirdropClaim(
        signer,
        daveAddr,
        amount,
        airdrop.address,
        chainId,
      );

      await assert.rejects(
        airdrop.write.claimWithSignature([amount + 1n, v, r, s], { account: dave.account }),
        /InvalidSignature/,
      );
    });

    it("reverts InvalidSignature when another caller tries to steal a recipient's signature", async function () {
      const { airdrop, chainId, signer, dave, eve } =
        await networkHelpers.loadFixture(deployFixture);
      const daveAddr = getAddress(dave.account.address);
      const amount = parseEther("50");

      const { v, r, s } = await signAirdropClaim(
        signer,
        daveAddr,
        amount,
        airdrop.address,
        chainId,
      );

      // Eve submits Dave's signature
      await assert.rejects(
        airdrop.write.claimWithSignature([amount, v, r, s], { account: eve.account }),
        /InvalidSignature/,
      );
    });

    it("reverts InvalidSignature when replaying a signature against a different contract deployment", async function () {
      const { tree, token, airdrop, chainId, deployer, signer, dave } =
        await networkHelpers.loadFixture(deployFixture);

      // Deploy a second MerkleAirdrop instance with identical token, root, and signer
      const airdrop2 = await viem.deployContract("MerkleAirdrop", [
        token.address,
        tree.root,
        signer.account.address,
      ]);
      // Deployer holds 0 tokens because deployFixture transferred all supply to airdrop, so deploy fresh token for airdrop2
      const token2 = await viem.deployContract("Token", ["Token 2", "TK2", parseEther("1000")]);
      const airdropOther = await viem.deployContract("MerkleAirdrop", [
        token2.address,
        tree.root,
        signer.account.address,
      ]);
      await token2.write.transfer([airdropOther.address, parseEther("1000")], {
        account: deployer.account,
      });

      const daveAddr = getAddress(dave.account.address);
      const amount = parseEther("50");

      // Sign specifically for `airdrop.address`
      const { v, r, s } = await signAirdropClaim(
        signer,
        daveAddr,
        amount,
        airdrop.address,
        chainId,
      );

      // Replay against `airdropOther` (and `airdrop2`) must fail
      await assert.rejects(
        airdropOther.write.claimWithSignature([amount, v, r, s], { account: dave.account }),
        /InvalidSignature/,
      );
      await assert.rejects(
        airdrop2.write.claimWithSignature([amount, v, r, s], { account: dave.account }),
        /InvalidSignature/,
      );
    });

    it("reverts InvalidSignature for malformed or malleable high-s signatures", async function () {
      const { airdrop, chainId, signer, dave } = await networkHelpers.loadFixture(deployFixture);
      const daveAddr = getAddress(dave.account.address);
      const amount = parseEther("50");

      const { v, r, s } = await signAirdropClaim(
        signer,
        daveAddr,
        amount,
        airdrop.address,
        chainId,
      );

      // Malformed v -> ecrecover returns address(0) / invalid v
      await assert.rejects(
        airdrop.write.claimWithSignature([amount, 0, r, s], { account: dave.account }),
        /InvalidSignature/,
      );

      // Malleable high-s signature: s' = N - s, v' = 27 <-> 28
      const malleableS =
        `0x${(SECP256K1_ORDER - BigInt(s)).toString(16).padStart(64, "0")}` as `0x${string}`;
      const malleableV = v === 27 ? 28 : 27;

      await assert.rejects(
        airdrop.write.claimWithSignature([amount, malleableV, r, malleableS], {
          account: dave.account,
        }),
        /InvalidSignature/,
      );
    });
  });

  describe("shared hasClaimed prevents double claims and cross-path replay", function () {
    it("prevents claiming twice via Merkle proof", async function () {
      const { entries, tree, airdrop, alice } = await networkHelpers.loadFixture(deployFixture);
      const proof = tree.getProof(0);

      await airdrop.write.claim([entries[0].amount, proof], { account: alice.account });

      await assert.rejects(
        airdrop.write.claim([entries[0].amount, proof], { account: alice.account }),
        /AlreadyClaimed/,
      );
    });

    it("prevents claiming twice via signature", async function () {
      const { airdrop, chainId, signer, dave } = await networkHelpers.loadFixture(deployFixture);
      const daveAddr = getAddress(dave.account.address);
      const amount = parseEther("50");

      const { v, r, s } = await signAirdropClaim(
        signer,
        daveAddr,
        amount,
        airdrop.address,
        chainId,
      );
      await airdrop.write.claimWithSignature([amount, v, r, s], { account: dave.account });

      await assert.rejects(
        airdrop.write.claimWithSignature([amount, v, r, s], { account: dave.account }),
        /AlreadyClaimed/,
      );
    });

    it("blocks signature claim after Merkle claim, and blocks Merkle claim after signature claim", async function () {
      const { entries, tree, airdrop, chainId, signer, alice, eve } =
        await networkHelpers.loadFixture(deployFixture);

      // 1. Alice claims via Merkle proof, then tries to claim again via admin signature
      await airdrop.write.claim([entries[0].amount, tree.getProof(0)], { account: alice.account });
      const aliceSig = await signAirdropClaim(
        signer,
        getAddress(alice.account.address),
        parseEther("50"),
        airdrop.address,
        chainId,
      );
      await assert.rejects(
        airdrop.write.claimWithSignature([parseEther("50"), aliceSig.v, aliceSig.r, aliceSig.s], {
          account: alice.account,
        }),
        /AlreadyClaimed/,
      );

      // 2. Eve (entry index 3) claims via admin signature first, then tries Merkle proof
      const eveSig = await signAirdropClaim(
        signer,
        getAddress(eve.account.address),
        entries[3].amount,
        airdrop.address,
        chainId,
      );
      await airdrop.write.claimWithSignature([entries[3].amount, eveSig.v, eveSig.r, eveSig.s], {
        account: eve.account,
      });

      await assert.rejects(
        airdrop.write.claim([entries[3].amount, tree.getProof(3)], { account: eve.account }),
        /AlreadyClaimed/,
      );
    });
  });
});
