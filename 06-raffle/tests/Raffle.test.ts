import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { getAddress, parseEther } from "viem";

const { viem, networkHelpers } = await network.connect();

const KEY_HASH = "0x0000000000000000000000000000000000000000000000000000000000000000";
const CALLBACK_GAS = 500_000;

// Starter test: the happy path end to end — two deposits, time travel to the
// deadline, a forced VRF response, and a claim. It fails until deposit,
// drawWinner, fulfillRandomWords, and claim work. Don't edit it. Add tests for
// the failure modes and the weighted-pick boundaries in a separate file.
describe("Raffle", function () {
  async function deployFixture() {
    const [deployer, alice, bob] = await viem.getWalletClients();

    const btc = await viem.deployContract("Token", ["Bitcoin", "BTC", parseEther("1000000")]);
    const feed = await viem.deployContract("PriceFeedMock", [8, 60_000n * 10n ** 8n]);

    const coord = await viem.deployContract("VRFCoordinatorMock", [
      10n ** 17n,
      10n ** 9n,
      10n ** 15n,
    ]);

    await coord.write.createSubscription();
    const [created] = await coord.getEvents.SubscriptionCreated({}, { fromBlock: 0n });
    const subId = created.args.subId as bigint;
    await coord.write.fundSubscription([subId, parseEther("1000000")]);

    const now = await networkHelpers.time.latest();
    const drawTime = BigInt(now + 600);

    const raffle = await viem.deployContract("Raffle", [
      btc.address,
      feed.address,
      drawTime,
      coord.address,
      subId,
      KEY_HASH,
      CALLBACK_GAS,
    ]);
    await coord.write.addConsumer([subId, raffle.address]);

    for (const w of [alice, bob]) {
      await btc.write.transfer([w.account.address, parseEther("100")]);
      await btc.write.approve([raffle.address, parseEther("100")], { account: w.account });
    }

    return { btc, feed, coord, raffle, subId, drawTime, deployer, alice, bob };
  }

  it("runs the full raffle: deposit, draw, weighted winner, claim", async function () {
    const { btc, coord, raffle, drawTime, alice, bob } = await deployFixture();

    // Entry 0: alice (weight 1 BTC). Entry 1: bob (weight 3 BTC).
    await raffle.write.deposit([parseEther("1")], { account: alice.account });
    await raffle.write.deposit([parseEther("3")], { account: bob.account });

    await networkHelpers.time.increaseTo(drawTime);
    await raffle.write.drawWinner();

    const requestId = (await raffle.read.requestId()) as bigint;
    const totalWeight = (await raffle.read.totalWeight()) as bigint;

    // A random word at the top of the range lands in bob's entry (index 1).
    await coord.write.fulfillRandomWordsWithOverride([
      requestId,
      raffle.address,
      [totalWeight - 1n],
    ]);

    const before = (await btc.read.balanceOf([bob.account.address])) as bigint;
    await raffle.write.claim([1n], { account: bob.account });
    const after = (await btc.read.balanceOf([bob.account.address])) as bigint;

    assert.equal(after - before, parseEther("4"));
  });

  describe("weighted-pick boundaries and dynamic USD pricing", function () {
    it("maintains a running total of deposited tokens across deposits", async function () {
      const { raffle, alice, bob } = await networkHelpers.loadFixture(deployFixture);

      assert.equal(await raffle.read.totalTokens(), 0n);
      assert.equal(await raffle.read.totalDeposited(), 0n);
      assert.equal(await raffle.read.totalDeposits(), 0n);

      await raffle.write.deposit([parseEther("1.5")], { account: alice.account });
      assert.equal(await raffle.read.totalTokens(), parseEther("1.5"));
      assert.equal(await raffle.read.totalDeposited(), parseEther("1.5"));
      assert.equal(await raffle.read.totalDeposits(), parseEther("1.5"));

      await raffle.write.deposit([parseEther("2.5")], { account: bob.account });
      assert.equal(await raffle.read.totalTokens(), parseEther("4"));
      assert.equal(await raffle.read.totalDeposited(), parseEther("4"));
      assert.equal(await raffle.read.totalDeposits(), parseEther("4"));
      assert.equal(await raffle.read.entryCount(), 2n);
    });

    it("selects entry 0 on randomWord = 0 and at entry 0 upper boundary (endWeight - 1)", async function () {
      const { btc, coord, raffle, drawTime, alice, bob } =
        await networkHelpers.loadFixture(deployFixture);

      await raffle.write.deposit([parseEther("1")], { account: alice.account });
      await raffle.write.deposit([parseEther("3")], { account: bob.account });

      const [, , aliceEnd] = await raffle.read.entries([0n]);

      await networkHelpers.time.increaseTo(drawTime);
      await raffle.write.drawWinner();
      const requestId = (await raffle.read.requestId()) as bigint;

      // Exact upper boundary of Entry 0 (aliceEnd - 1)
      await coord.write.fulfillRandomWordsWithOverride([
        requestId,
        raffle.address,
        [aliceEnd - 1n],
      ]);

      // Bob cannot claim index 0 or index 1
      await assert.rejects(raffle.write.claim([0n], { account: bob.account }), /InvalidClaim/);
      await assert.rejects(raffle.write.claim([1n], { account: bob.account }), /InvalidClaim/);
      // Alice cannot claim index 1
      await assert.rejects(raffle.write.claim([1n], { account: alice.account }), /InvalidClaim/);

      const before = await btc.read.balanceOf([alice.account.address]);
      await raffle.write.claim([0n], { account: alice.account });
      const after = await btc.read.balanceOf([alice.account.address]);
      assert.equal(after - before, parseEther("4"));
    });

    it("selects entry 1 at exact boundary randomWord = entry0.endWeight", async function () {
      const { btc, coord, raffle, drawTime, alice, bob } =
        await networkHelpers.loadFixture(deployFixture);

      await raffle.write.deposit([parseEther("1")], { account: alice.account });
      await raffle.write.deposit([parseEther("3")], { account: bob.account });

      const [, , aliceEnd] = await raffle.read.entries([0n]);

      await networkHelpers.time.increaseTo(drawTime);
      await raffle.write.drawWinner();
      const requestId = (await raffle.read.requestId()) as bigint;

      // Exact lower boundary of Entry 1 (aliceEnd)
      await coord.write.fulfillRandomWordsWithOverride([requestId, raffle.address, [aliceEnd]]);

      await assert.rejects(raffle.write.claim([0n], { account: alice.account }), /InvalidClaim/);

      const before = await btc.read.balanceOf([bob.account.address]);
      await raffle.write.claim([1n], { account: bob.account });
      const after = await btc.read.balanceOf([bob.account.address]);
      assert.equal(after - before, parseEther("4"));
    });

    it("wraps randomWord modulo totalWeight cleanly", async function () {
      const { btc, coord, raffle, drawTime, alice, bob } =
        await networkHelpers.loadFixture(deployFixture);

      await raffle.write.deposit([parseEther("1")], { account: alice.account });
      await raffle.write.deposit([parseEther("3")], { account: bob.account });

      const totalWeight = await raffle.read.totalWeight();
      await networkHelpers.time.increaseTo(drawTime);
      await raffle.write.drawWinner();
      const requestId = (await raffle.read.requestId()) as bigint;

      // totalWeight % totalWeight == 0 -> lands in Entry 0 (alice)
      await coord.write.fulfillRandomWordsWithOverride([requestId, raffle.address, [totalWeight]]);

      await raffle.write.claim([0n], { account: alice.account });
      assert.equal(await raffle.read.winner(), getAddress(alice.account.address));
      assert.equal(await btc.read.balanceOf([alice.account.address]), parseEther("103"));
    });

    it("locks each deposit's USD weight at entry time even when token price changes later", async function () {
      const { feed, coord, raffle, drawTime, alice, bob } =
        await networkHelpers.loadFixture(deployFixture);

      // Alice deposits 1 BTC at $60,000 -> weight = 60,000e18
      await raffle.write.deposit([parseEther("1")], { account: alice.account });

      // Token price triples to $180,000
      await feed.write.updateAnswer([180_000n * 10n ** 8n]);

      // Bob deposits 1 BTC at $180,000 -> weight = 180,000e18 (3x Alice's weight)
      await raffle.write.deposit([parseEther("1")], { account: bob.account });

      const [, aliceStart, aliceEnd] = await raffle.read.entries([0n]);
      const [, bobStart, bobEnd] = await raffle.read.entries([1n]);

      assert.equal(aliceEnd - aliceStart, parseEther("60000"));
      assert.equal(bobStart, parseEther("60000"));
      assert.equal(bobEnd - bobStart, parseEther("180000"));
      assert.equal(await raffle.read.totalWeight(), parseEther("240000"));

      // Ticket 60,000e18 belongs to Bob (even though both deposited 1 BTC)
      await networkHelpers.time.increaseTo(drawTime);
      await raffle.write.drawWinner();
      const requestId = (await raffle.read.requestId()) as bigint;
      await coord.write.fulfillRandomWordsWithOverride([
        requestId,
        raffle.address,
        [parseEther("60000")],
      ]);

      await raffle.write.claim([1n], { account: bob.account });
      assert.equal(await raffle.read.winner(), getAddress(bob.account.address));
    });

    it("supports multiple deposits by the same player and requires the exact winning entryIndex", async function () {
      const { btc, coord, raffle, drawTime, alice, bob } =
        await networkHelpers.loadFixture(deployFixture);

      // Entry 0: alice ($60k), Entry 1: bob ($60k), Entry 2: alice ($60k)
      await raffle.write.deposit([parseEther("1")], { account: alice.account });
      await raffle.write.deposit([parseEther("1")], { account: bob.account });
      await raffle.write.deposit([parseEther("1")], { account: alice.account });

      const [, , end1] = await raffle.read.entries([1n]);

      await networkHelpers.time.increaseTo(drawTime);
      await raffle.write.drawWinner();
      const requestId = (await raffle.read.requestId()) as bigint;
      await coord.write.fulfillRandomWordsWithOverride([requestId, raffle.address, [end1]]);

      // Alice won via Entry 2; claiming with Entry 0 must fail
      await assert.rejects(raffle.write.claim([0n], { account: alice.account }), /InvalidClaim/);
      await raffle.write.claim([2n], { account: alice.account });
      assert.equal(await btc.read.balanceOf([raffle.address]), 0n);
    });
  });

  describe("deposit failure modes and price feed validation", function () {
    it("reverts ZeroAmount on zero deposit", async function () {
      const { raffle, alice } = await networkHelpers.loadFixture(deployFixture);
      await assert.rejects(raffle.write.deposit([0n], { account: alice.account }), /ZeroAmount/);
    });

    it("reverts RaffleClosed after drawTime or after drawWinner is called", async function () {
      const { raffle, drawTime, alice, bob } = await networkHelpers.loadFixture(deployFixture);
      await raffle.write.deposit([parseEther("1")], { account: alice.account });

      await networkHelpers.time.increaseTo(drawTime);
      await assert.rejects(
        raffle.write.deposit([parseEther("1")], { account: bob.account }),
        /RaffleClosed/,
      );

      await raffle.write.drawWinner();
      await assert.rejects(
        raffle.write.deposit([parseEther("1")], { account: bob.account }),
        /RaffleClosed/,
      );
    });

    it("reverts InvalidPrice when feed price is zero, negative, or missing updatedAt", async function () {
      const { feed, raffle, alice } = await networkHelpers.loadFixture(deployFixture);

      // Zero price
      await feed.write.updateAnswer([0n]);
      await assert.rejects(
        raffle.write.deposit([parseEther("1")], { account: alice.account }),
        /InvalidPrice/,
      );

      // Negative price
      await feed.write.updateAnswer([-100n]);
      await assert.rejects(
        raffle.write.deposit([parseEther("1")], { account: alice.account }),
        /InvalidPrice/,
      );

      // Missing timestamp (updatedAt == 0)
      await feed.write.updateRoundData([2n, 60_000n * 10n ** 8n, 0n, 0n]);
      await assert.rejects(
        raffle.write.deposit([parseEther("1")], { account: alice.account }),
        /InvalidPrice/,
      );
    });

    it("reverts StalePrice when feed price is older than MAX_PRICE_AGE", async function () {
      const { feed, raffle, alice } = await networkHelpers.loadFixture(deployFixture);
      const maxAge = await raffle.read.MAX_PRICE_AGE();
      const now = BigInt(await networkHelpers.time.latest());

      // Set round updatedAt to more than MAX_PRICE_AGE in the past
      await feed.write.updateRoundData([2n, 60_000n * 10n ** 8n, now - maxAge - 1n, now]);
      await assert.rejects(
        raffle.write.deposit([parseEther("1")], { account: alice.account }),
        /StalePrice/,
      );
    });
  });

  describe("drawWinner, VRF callback, and claim failure modes", function () {
    it("reverts DrawTooEarly before drawTime, NoEntries with 0 deposits, and DrawAlreadyRequested on second draw", async function () {
      const { raffle, drawTime, alice } = await networkHelpers.loadFixture(deployFixture);

      await assert.rejects(raffle.write.drawWinner(), /DrawTooEarly/);

      await networkHelpers.time.increaseTo(drawTime);
      await assert.rejects(raffle.write.drawWinner(), /NoEntries/);

      // Deploy fresh raffle to test double-draw after valid deposit
      const fixture2 = await networkHelpers.loadFixture(deployFixture);
      await fixture2.raffle.write.deposit([parseEther("1")], { account: alice.account });
      await networkHelpers.time.increaseTo(fixture2.drawTime);
      await fixture2.raffle.write.drawWinner();

      await assert.rejects(fixture2.raffle.write.drawWinner(), /DrawAlreadyRequested/);
    });

    it("reverts OnlyCoordinatorCanFulfill if rawFulfillRandomWords is called directly", async function () {
      const { raffle, drawTime, alice } = await networkHelpers.loadFixture(deployFixture);
      await raffle.write.deposit([parseEther("1")], { account: alice.account });
      await networkHelpers.time.increaseTo(drawTime);
      await raffle.write.drawWinner();
      const reqId = await raffle.read.requestId();

      await assert.rejects(
        raffle.write.rawFulfillRandomWords([reqId, [42n]], { account: alice.account }),
        /OnlyCoordinatorCanFulfill/,
      );
    });

    it("reverts DrawNotFulfilled before VRF response, InvalidClaim for bad index, and AlreadyClaimed on double claim", async function () {
      const { coord, raffle, drawTime, alice } = await networkHelpers.loadFixture(deployFixture);
      await raffle.write.deposit([parseEther("1")], { account: alice.account });

      await networkHelpers.time.increaseTo(drawTime);
      await raffle.write.drawWinner();
      const reqId = await raffle.read.requestId();

      // Before fulfillment
      await assert.rejects(
        raffle.write.claim([0n], { account: alice.account }),
        /DrawNotFulfilled/,
      );

      await coord.write.fulfillRandomWordsWithOverride([reqId, raffle.address, [0n]]);

      // Out-of-bounds entryIndex
      await assert.rejects(raffle.write.claim([99n], { account: alice.account }), /InvalidClaim/);

      await viem.assertions.emitWithArgs(
        raffle.write.claim([0n], { account: alice.account }),
        raffle,
        "Claimed",
        [getAddress(alice.account.address), parseEther("1")],
      );

      // Cannot claim twice
      await assert.rejects(raffle.write.claim([0n], { account: alice.account }), /AlreadyClaimed/);
    });
  });
});
