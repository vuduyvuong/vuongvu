// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract USDCRaffle is Ownable, ReentrancyGuard {
    IERC20 public immutable usdc;
    uint256 public immutable ticketPrice;
    uint256 public immutable maxParticipants;

    address public treasury;
    address[] private participants;
    uint256 public potSize;
    mapping(address => uint256) public pendingWithdrawals;

    event TicketPurchased(address buyer, uint256 ticketNumber);
    event WinnerDrawn(address winner, uint256 prize);
    event RaffleReset();
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);

    error InvalidAddress();
    error InvalidConfig();
    error RaffleFull();
    error NoParticipants();
    error TransferFailed();

    constructor(
        address usdcToken,
        uint256 ticketPrice_,
        uint256 maxParticipants_,
        address treasury_,
        address initialOwner
    ) Ownable(initialOwner) {
        if (usdcToken == address(0) || treasury_ == address(0) || initialOwner == address(0)) {
            revert InvalidAddress();
        }
        if (ticketPrice_ == 0 || maxParticipants_ == 0) {
            revert InvalidConfig();
        }

        usdc = IERC20(usdcToken);
        ticketPrice = ticketPrice_;
        maxParticipants = maxParticipants_;
        treasury = treasury_;
    }

    function buyTicket() external nonReentrant {
        if (participants.length >= maxParticipants) {
            revert RaffleFull();
        }

        bool success = usdc.transferFrom(msg.sender, address(this), ticketPrice);
        if (!success) {
            revert TransferFailed();
        }

        participants.push(msg.sender);
        potSize += ticketPrice;

        emit TicketPurchased(msg.sender, participants.length);

        if (participants.length == maxParticipants) {
            _drawWinner();
        }
    }

    function drawWinner() external nonReentrant onlyOwner {
        _drawWinner();
    }

    function resetRaffle() external onlyOwner nonReentrant {
        uint256 participantCount = participants.length;
        if (participantCount == 0) {
            revert NoParticipants();
        }

        for (uint256 i = 0; i < participantCount; ++i) {
            pendingWithdrawals[participants[i]] += ticketPrice;
        }

        _clearRaffleState();
        emit RaffleReset();
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) {
            revert InvalidAddress();
        }
        address oldTreasury = treasury;
        treasury = newTreasury;
        emit TreasuryUpdated(oldTreasury, newTreasury);
    }

    function claimWinnings() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        pendingWithdrawals[msg.sender] = 0;

        bool success = usdc.transfer(msg.sender, amount);
        if (!success) {
            pendingWithdrawals[msg.sender] = amount;
            revert TransferFailed();
        }
    }

    function getParticipants() external view returns (address[] memory) {
        return participants;
    }

    function getRaffleStatus()
        external
        view
        returns (uint256 currentTicketCount, uint256 maxTickets, uint256 currentTicketPrice, uint256 currentPotSize)
    {
        return (participants.length, maxParticipants, ticketPrice, potSize);
    }

    function _drawWinner() internal {
        uint256 participantCount = participants.length;
        if (participantCount == 0) {
            revert NoParticipants();
        }

        // WARNING: This randomness approach is NOT safe for production use.
        // Validators and MEV bots can influence blockhash and block.timestamp,
        // which can bias or manipulate winner selection outcomes.
        // For real-value funds, use Chainlink VRF or a commit-reveal scheme.
        uint256 randomNumber = uint256(
            keccak256(abi.encodePacked(blockhash(block.number - 1), block.timestamp, participantCount))
        );
        uint256 winnerIndex = randomNumber % participantCount;
        address winner = participants[winnerIndex];

        uint256 totalPot = potSize;
        uint256 winnerPrize = (totalPot * 95) / 100;
        uint256 treasuryFee = totalPot - winnerPrize;

        pendingWithdrawals[winner] += winnerPrize;
        pendingWithdrawals[treasury] += treasuryFee;

        emit WinnerDrawn(winner, winnerPrize);

        _clearRaffleState();
        emit RaffleReset();
    }

    function _clearRaffleState() internal {
        delete participants;
        potSize = 0;
    }
}
