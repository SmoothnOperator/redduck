import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { getAddress, parseEther } from "viem";

const { viem, networkHelpers } = await network.connect();

describe("Pair (pull-based AMM)", function () {
  async function deployFixture() {
    const [deployer, alice, bob] = await viem.getWalletClients();

    const tokenA = await viem.deployContract("Token", ["Token A", "AAA", parseEther("1000000")]);
    const tokenB = await viem.deployContract("Token", ["Token B", "BBB", parseEther("1000000")]);

    const pair = await viem.deployContract("Pair", [tokenA.address, tokenB.address]);

    await tokenA.write.transfer([alice.account.address, parseEther("100000")]);
    await tokenB.write.transfer([alice.account.address, parseEther("100000")]);
    await tokenA.write.transfer([bob.account.address, parseEther("100000")]);
    await tokenB.write.transfer([bob.account.address, parseEther("100000")]);

    for (const w of [deployer, alice, bob]) {
      await tokenA.write.approve([pair.address, parseEther("1000000")], { account: w.account });
      await tokenB.write.approve([pair.address, parseEther("1000000")], { account: w.account });
    }

    return { pair, tokenA, tokenB, deployer, alice, bob };
  }

  it("a swap charges the 0.3% fee, moves the price, and does not let k decrease", async function () {
    const { pair, tokenA, alice } = await deployFixture();

    await pair.write.addLiquidity([parseEther("1000"), parseEther("1000")]);

    const r0Before = (await pair.read.reserve0()) as bigint;
    const r1Before = (await pair.read.reserve1()) as bigint;
    const kBefore = r0Before * r1Before;

    const amountIn = parseEther("100");
    const expectedOut = (await pair.read.getAmountOut([amountIn, r0Before, r1Before])) as bigint;

    await pair.write.swap([tokenA.address, amountIn, 0n], { account: alice.account });

    const r0After = (await pair.read.reserve0()) as bigint;
    const r1After = (await pair.read.reserve1()) as bigint;

    assert.equal(r0After, r0Before + amountIn);
    assert.equal(r1After, r1Before - expectedOut);
    assert.ok(
      expectedOut > parseEther("90") && expectedOut < parseEther("91"),
      `got ${expectedOut}`,
    );
    assert.ok(r0After * r1After > kBefore, "k must not decrease across a swap");
  });

  describe("getAmountOut", function () {
    it("computes constant-product output with 0.3% fee", async function () {
      const { pair } = await networkHelpers.loadFixture(deployFixture);

      const amountIn = parseEther("100");
      const reserveIn = parseEther("1000");
      const reserveOut = parseEther("2000");

      const expected = (amountIn * 997n * reserveOut) / (reserveIn * 1000n + amountIn * 997n);
      const actual = await pair.read.getAmountOut([amountIn, reserveIn, reserveOut]);
      assert.equal(actual, expected);
    });

    it("reverts with InsufficientAmount when amountIn is 0", async function () {
      const { pair } = await networkHelpers.loadFixture(deployFixture);
      await assert.rejects(pair.read.getAmountOut([0n, 1000n, 1000n]), /InsufficientAmount/);
    });

    it("reverts with InsufficientLiquidity when either reserve is 0", async function () {
      const { pair } = await networkHelpers.loadFixture(deployFixture);
      await assert.rejects(pair.read.getAmountOut([100n, 0n, 1000n]), /InsufficientLiquidity/);
      await assert.rejects(pair.read.getAmountOut([100n, 1000n, 0n]), /InsufficientLiquidity/);
    });
  });

  describe("liquidity provision and removal", function () {
    it("mints initial LP minus MINIMUM_LIQUIDITY and locks MINIMUM_LIQUIDITY forever", async function () {
      const { pair, deployer } = await networkHelpers.loadFixture(deployFixture);

      const amt0 = parseEther("100");
      const amt1 = parseEther("400");
      const totalMinted = parseEther("200");
      const minLiq = await pair.read.MINIMUM_LIQUIDITY();
      const expectedLp = totalMinted - minLiq;

      await viem.assertions.emitWithArgs(
        pair.write.addLiquidity([amt0, amt1]),
        pair,
        "LiquidityAdded",
        [getAddress(deployer.account.address), amt0, amt1, expectedLp],
      );

      assert.equal(await pair.read.balanceOf([deployer.account.address]), expectedLp);
      assert.equal(
        await pair.read.balanceOf(["0x000000000000000000000000000000000000dEaD"]),
        minLiq,
      );
      assert.equal(await pair.read.totalSupply(), totalMinted);
      assert.equal(await pair.read.reserve0(), amt0);
      assert.equal(await pair.read.reserve1(), amt1);
    });

    it("reverts addLiquidity when either deposit is 0 or initial deposit <= MINIMUM_LIQUIDITY", async function () {
      const { pair } = await networkHelpers.loadFixture(deployFixture);
      await assert.rejects(pair.write.addLiquidity([0n, parseEther("10")]), /InsufficientAmount/);
      await assert.rejects(pair.write.addLiquidity([parseEther("10"), 0n]), /InsufficientAmount/);
      await assert.rejects(pair.write.addLiquidity([1000n, 1000n]), /InsufficientLiquidity/);
    });

    it("mints proportional LP for subsequent equal-ratio and out-of-ratio deposits", async function () {
      const { pair, alice, bob } = await networkHelpers.loadFixture(deployFixture);
      await pair.write.addLiquidity([parseEther("1000"), parseEther("1000")]);

      const supplyBefore = await pair.read.totalSupply();
      await pair.write.addLiquidity([parseEther("250"), parseEther("250")], {
        account: alice.account,
      });

      assert.equal(await pair.read.balanceOf([alice.account.address]), parseEther("250"));
      assert.equal(await pair.read.totalSupply(), supplyBefore + parseEther("250"));
      assert.equal(await pair.read.reserve0(), parseEther("1250"));
      assert.equal(await pair.read.reserve1(), parseEther("1250"));

      // Out-of-ratio deposit: smaller side governs minted LP
      await pair.write.addLiquidity([parseEther("125"), parseEther("500")], {
        account: bob.account,
      });
      assert.equal(await pair.read.balanceOf([bob.account.address]), parseEther("125"));
      assert.equal(await pair.read.reserve0(), parseEther("1375"));
      assert.equal(await pair.read.reserve1(), parseEther("1750"));
    });

    it("defends against first-depositor inflation attack via MINIMUM_LIQUIDITY lock", async function () {
      const { pair, tokenA, tokenB, deployer, alice } =
        await networkHelpers.loadFixture(deployFixture);

      await pair.write.addLiquidity([1001n, 1001n]);
      assert.equal(await pair.read.balanceOf([deployer.account.address]), 1n);
      assert.equal(await pair.read.totalSupply(), 1001n);

      await tokenA.write.transfer([pair.address, parseEther("100")]);
      await tokenB.write.transfer([pair.address, parseEther("100")]);
      await pair.write.swap([tokenA.address, parseEther("1"), 0n]);

      await pair.write.addLiquidity([parseEther("10"), parseEther("10")], {
        account: alice.account,
      });
      const aliceLp = await pair.read.balanceOf([alice.account.address]);
      assert.ok(aliceLp > 0n, "victim LP should not round to zero");

      const aBefore = await tokenA.read.balanceOf([deployer.account.address]);
      await pair.write.removeLiquidity([1n]);
      const aAfter = await tokenA.read.balanceOf([deployer.account.address]);
      assert.ok(aAfter - aBefore < parseEther("1"), "attacker must suffer loss");
    });

    it("removes liquidity proportionally, emits LiquidityRemoved, and leaves MINIMUM_LIQUIDITY locked", async function () {
      const { pair, tokenA, tokenB, deployer } = await networkHelpers.loadFixture(deployFixture);

      const depositAmt = parseEther("1000");
      await pair.write.addLiquidity([depositAmt, depositAmt]);

      const lpBalance = await pair.read.balanceOf([deployer.account.address]);
      const minLiq = await pair.read.MINIMUM_LIQUIDITY();
      assert.equal(lpBalance, depositAmt - minLiq);

      const aBefore = await tokenA.read.balanceOf([deployer.account.address]);
      const bBefore = await tokenB.read.balanceOf([deployer.account.address]);

      await viem.assertions.emitWithArgs(
        pair.write.removeLiquidity([lpBalance]),
        pair,
        "LiquidityRemoved",
        [getAddress(deployer.account.address), lpBalance, lpBalance, lpBalance],
      );

      assert.equal(await pair.read.balanceOf([deployer.account.address]), 0n);
      assert.equal(await pair.read.totalSupply(), minLiq);
      assert.equal(await pair.read.reserve0(), minLiq);
      assert.equal(await pair.read.reserve1(), minLiq);
      assert.equal((await tokenA.read.balanceOf([deployer.account.address])) - aBefore, lpBalance);
      assert.equal((await tokenB.read.balanceOf([deployer.account.address])) - bBefore, lpBalance);
    });

    it("accrues 0.3% swap fees to LPs upon removal and rejects invalid removals", async function () {
      const { pair, tokenA, tokenB, deployer, alice } =
        await networkHelpers.loadFixture(deployFixture);

      await pair.write.addLiquidity([parseEther("1000"), parseEther("1000")]);
      const lp = await pair.read.balanceOf([deployer.account.address]);

      await pair.write.swap([tokenA.address, parseEther("100"), 0n], { account: alice.account });
      await pair.write.swap([tokenB.address, parseEther("100"), 0n], { account: alice.account });

      const aBefore = await tokenA.read.balanceOf([deployer.account.address]);
      const bBefore = await tokenB.read.balanceOf([deployer.account.address]);
      await pair.write.removeLiquidity([lp]);

      const gotA = (await tokenA.read.balanceOf([deployer.account.address])) - aBefore;
      const gotB = (await tokenB.read.balanceOf([deployer.account.address])) - bBefore;
      assert.ok(gotA * gotB > lp * lp, "LP should realize accrued fee value");

      await assert.rejects(pair.write.removeLiquidity([0n]), /InsufficientLiquidity/);
      await assert.rejects(pair.write.removeLiquidity([1n], { account: alice.account }));
    });
  });

  describe("swap behavior (both directions and protections)", function () {
    it("swaps token0 for token1 and verifies balances, reserves, and event", async function () {
      const { pair, tokenA, tokenB, alice } = await networkHelpers.loadFixture(deployFixture);
      await pair.write.addLiquidity([parseEther("1000"), parseEther("1000")]);

      const amtIn = parseEther("50");
      const r0Before = await pair.read.reserve0();
      const r1Before = await pair.read.reserve1();
      const expectedOut = await pair.read.getAmountOut([amtIn, r0Before, r1Before]);

      const aBefore = await tokenA.read.balanceOf([alice.account.address]);
      const bBefore = await tokenB.read.balanceOf([alice.account.address]);

      await viem.assertions.emitWithArgs(
        pair.write.swap([tokenA.address, amtIn, expectedOut], { account: alice.account }),
        pair,
        "Swapped",
        [getAddress(alice.account.address), getAddress(tokenA.address), amtIn, expectedOut],
      );

      assert.equal(aBefore - (await tokenA.read.balanceOf([alice.account.address])), amtIn);
      assert.equal((await tokenB.read.balanceOf([alice.account.address])) - bBefore, expectedOut);
      assert.equal(await pair.read.reserve0(), r0Before + amtIn);
      assert.equal(await pair.read.reserve1(), r1Before - expectedOut);
    });

    it("swaps token1 for token0 and verifies balances, reserves, and event", async function () {
      const { pair, tokenA, tokenB, alice } = await networkHelpers.loadFixture(deployFixture);
      await pair.write.addLiquidity([parseEther("1000"), parseEther("1000")]);

      const amtIn = parseEther("50");
      const r0Before = await pair.read.reserve0();
      const r1Before = await pair.read.reserve1();
      const expectedOut = await pair.read.getAmountOut([amtIn, r1Before, r0Before]);

      const aBefore = await tokenA.read.balanceOf([alice.account.address]);
      const bBefore = await tokenB.read.balanceOf([alice.account.address]);

      await viem.assertions.emitWithArgs(
        pair.write.swap([tokenB.address, amtIn, expectedOut], { account: alice.account }),
        pair,
        "Swapped",
        [getAddress(alice.account.address), getAddress(tokenB.address), amtIn, expectedOut],
      );

      assert.equal(bBefore - (await tokenB.read.balanceOf([alice.account.address])), amtIn);
      assert.equal((await tokenA.read.balanceOf([alice.account.address])) - aBefore, expectedOut);
      assert.equal(await pair.read.reserve0(), r0Before - expectedOut);
      assert.equal(await pair.read.reserve1(), r1Before + amtIn);
    });

    it("reverts on invalid token, slippage failure, zero amount, and empty pool", async function () {
      const { pair, tokenA, alice } = await networkHelpers.loadFixture(deployFixture);

      await assert.rejects(
        pair.write.swap([tokenA.address, parseEther("10"), 0n], { account: alice.account }),
        /InsufficientLiquidity/,
      );

      await pair.write.addLiquidity([parseEther("1000"), parseEther("1000")]);

      const thirdToken = await viem.deployContract("Token", ["Other", "OTH", parseEther("1000")]);
      await assert.rejects(
        pair.write.swap([thirdToken.address, parseEther("10"), 0n], { account: alice.account }),
        /InvalidToken/,
      );

      const amtIn = parseEther("100");
      const out = await pair.read.getAmountOut([amtIn, parseEther("1000"), parseEther("1000")]);
      await assert.rejects(
        pair.write.swap([tokenA.address, amtIn, out + 1n], { account: alice.account }),
        /InsufficientOutput/,
      );

      await assert.rejects(
        pair.write.swap([tokenA.address, 0n, 0n], { account: alice.account }),
        /InsufficientAmount/,
      );
    });
  });
});
