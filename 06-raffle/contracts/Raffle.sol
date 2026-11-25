// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {VRFConsumerBaseV2Plus} from "@chainlink/contracts/src/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol";
import {VRFV2PlusClient} from "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";
import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

// Raffle — players deposit a volatile token; each deposit's USD value at entry
// time (from a Chainlink price feed) sets its win probability. After drawTime a
// Chainlink VRF draw picks a weighted winner, who claims the whole pot.
//
// Randomness is asynchronous: drawWinner() requests a random word and returns
// immediately; the VRF coordinator calls fulfillRandomWords() back some blocks
// later. The data structure for the weighted draw and the claim verification are
// yours to design — you may not import a library that solves the weighted-draw
// or random-selection problem. See TASK.md for the full behavior spec.
contract Raffle is VRFConsumerBaseV2Plus {
    struct Entry {
        address player;
        uint256 startWeight;
        uint256 endWeight;
    }

    IERC20 public immutable token; // deposit token
    AggregatorV3Interface public immutable priceFeed; // token/USD feed
    uint256 public immutable drawTime;

    uint256 public immutable subscriptionId;
    bytes32 public immutable keyHash;
    uint32 public immutable callbackGasLimit;
    uint16 public constant REQUEST_CONFIRMATIONS = 3;
    uint32 public constant NUM_WORDS = 1;

    uint256 public constant MAX_PRICE_AGE = 1 hours; // feed staleness bound

    Entry[] public entries;
    uint256 public totalWeight;
    /// @notice Running total of deposited tokens across all entries.
    uint256 public totalTokens;
    uint256 public requestId;
    uint256 public randomWord;

    bool public drawRequested;
    bool public fulfilled;
    bool public claimed;
    address public winner;

    error InvalidClaim();
    error RaffleClosed();
    error ZeroAmount();
    error ZeroWeight();
    error InvalidPrice();
    error StalePrice();
    error TransferFailed();
    error DrawTooEarly();
    error DrawAlreadyRequested();
    error NoEntries();
    error InvalidRequest();
    error AlreadyFulfilled();
    error DrawNotFulfilled();
    error AlreadyClaimed();

    event Deposited(address indexed who, uint256 amount, uint256 weight);
    event DrawRequested(uint256 requestId);
    event WinnerPicked(address indexed winner);
    event Claimed(address indexed winner, uint256 amount);

    constructor(
        IERC20 _token,
        AggregatorV3Interface _priceFeed,
        uint256 _drawTime,
        address _coordinator,
        uint256 _subscriptionId,
        bytes32 _keyHash,
        uint32 _callbackGasLimit
    ) VRFConsumerBaseV2Plus(_coordinator) {
        token = _token;
        priceFeed = _priceFeed;
        drawTime = _drawTime;
        subscriptionId = _subscriptionId;
        keyHash = _keyHash;
        callbackGasLimit = _callbackGasLimit;
    }

    /// @notice Join the raffle by depositing tokens while it is open. The deposit's
    ///         weight is its USD value at the current feed price, fixed at entry.
    ///         Reject prices that are missing, non-positive, or stale.
    function deposit(uint256 amount) external {
        if (block.timestamp >= drawTime || drawRequested) {
            revert RaffleClosed();
        }
        if (amount == 0) {
            revert ZeroAmount();
        }

        (uint80 roundId, int256 answer, , uint256 updatedAt, uint80 answeredInRound) = priceFeed.latestRoundData();
        if (answer <= 0 || updatedAt == 0 || updatedAt > block.timestamp || answeredInRound < roundId) {
            revert InvalidPrice();
        }
        if (block.timestamp - updatedAt > MAX_PRICE_AGE) {
            revert StalePrice();
        }

        uint256 weight = (amount * uint256(answer)) / (10 ** priceFeed.decimals());
        if (weight == 0) {
            revert ZeroWeight();
        }

        uint256 startWeight = totalWeight;
        uint256 endWeight = startWeight + weight;
        entries.push(Entry({player: msg.sender, startWeight: startWeight, endWeight: endWeight}));
        totalWeight = endWeight;
        totalTokens += amount;

        bool ok = token.transferFrom(msg.sender, address(this), amount);
        if (!ok) {
            revert TransferFailed();
        }

        emit Deposited(msg.sender, amount, weight);
    }

    /// @notice After drawTime, with at least one deposit, request a single random
    ///         word from VRF and track the returned request id. Only once.
    function drawWinner() external returns (uint256) {
        if (block.timestamp < drawTime) {
            revert DrawTooEarly();
        }
        if (drawRequested) {
            revert DrawAlreadyRequested();
        }
        if (entries.length == 0) {
            revert NoEntries();
        }

        drawRequested = true;

        uint256 reqId = s_vrfCoordinator.requestRandomWords(
            VRFV2PlusClient.RandomWordsRequest({
                keyHash: keyHash,
                subId: subscriptionId,
                requestConfirmations: REQUEST_CONFIRMATIONS,
                callbackGasLimit: callbackGasLimit,
                numWords: NUM_WORDS,
                extraArgs: VRFV2PlusClient._argsToBytes(VRFV2PlusClient.ExtraArgsV1({nativePayment: false}))
            })
        );

        requestId = reqId;
        emit DrawRequested(reqId);
        return reqId;
    }

    /// @notice VRF callback. Confirm the request id matches and record the random
    ///         word — nothing more. No transfers, no loops, no settlement here.
    function fulfillRandomWords(uint256 _requestId, uint256[] calldata randomWords) internal override {
        if (_requestId != requestId) {
            revert InvalidRequest();
        }
        if (fulfilled) {
            revert AlreadyFulfilled();
        }
        if (randomWords.length == 0) {
            revert InvalidRequest();
        }

        randomWord = randomWords[0];
        fulfilled = true;
    }

    /// @notice After the random word arrives, the winner claims the prize. The
    ///         caller supplies the index of the winning entry; verify it belongs
    ///         to msg.sender and is the winning entry, else revert InvalidClaim.
    function claim(uint256 entryIndex) external {
        if (claimed) {
            revert AlreadyClaimed();
        }
        if (!fulfilled) {
            revert DrawNotFulfilled();
        }
        if (entryIndex >= entries.length) {
            revert InvalidClaim();
        }

        Entry storage entry = entries[entryIndex];
        uint256 winningTicket = randomWord % totalWeight;

        if (entry.player != msg.sender || winningTicket < entry.startWeight || winningTicket >= entry.endWeight) {
            revert InvalidClaim();
        }

        claimed = true;
        winner = msg.sender;

        uint256 prize = token.balanceOf(address(this));
        bool ok = token.transfer(msg.sender, prize);
        if (!ok) {
            revert TransferFailed();
        }

        emit WinnerPicked(msg.sender);
        emit Claimed(msg.sender, prize);
    }

    /// @notice Number of deposited entries in the raffle.
    function entryCount() external view returns (uint256) {
        return entries.length;
    }

    /// @notice Running total of deposited tokens across all entries.
    function totalDeposited() external view returns (uint256) {
        return totalTokens;
    }

    /// @notice Running total of deposited tokens across all entries.
    function totalDeposits() external view returns (uint256) {
        return totalTokens;
    }
}
