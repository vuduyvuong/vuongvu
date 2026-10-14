import { useState, useCallback } from 'react'
import { ConnectKitButton } from 'connectkit'
import {
  useAccount,
  useReadContract,
  useWriteContract,
  useWaitForTransactionReceipt,
  useSwitchChain,
} from 'wagmi'
import { erc20Abi } from 'viem'
import { Ticket, Trophy, Users, RefreshCw, Gift, AlertCircle, CheckCircle2, Loader2 } from 'lucide-react'
import { TokenUSDC } from '@web3icons/react'
import { toast } from 'sonner'
import { getUsdc, requireChain, buildTxExplorerUrl } from '@/onchain-facts'
import { Amount, usdcDecimalsFor } from '@/onchain-money'
import raffleArtifact from '../contracts/out/USDCRaffle.sol/USDCRaffle.json'

// ── Contract config ──────────────────────────────────────────────────────────
const ARC_TESTNET_ID = 5042002
const RAFFLE_ADDRESS = '0x229e1107ffdfd2a2c838df13acd1cdeadf0c1c9e' as const
const RAFFLE_ABI = raffleArtifact.abi
const usdcFact = getUsdc(ARC_TESTNET_ID)!
const USDC_ADDRESS = usdcFact.address as `0x${string}`
const chain = requireChain(ARC_TESTNET_ID)

// ── Glass styles ─────────────────────────────────────────────────────────────
const glassCard: React.CSSProperties = {
  background: 'rgba(255,255,255,0.64)',
  backdropFilter: 'blur(24px) saturate(180%)',
  WebkitBackdropFilter: 'blur(24px) saturate(180%)',
  border: '1px solid rgba(255,255,255,0.68)',
  boxShadow: '0 8px 32px rgba(18,45,69,0.08), inset 0 1px 0 rgba(255,255,255,0.55)',
}
const glassInner: React.CSSProperties = {
  background: 'rgba(255,255,255,0.46)',
  border: '1px solid rgba(255,255,255,0.56)',
}

type BuyStep = 'idle' | 'approving' | 'approved' | 'buying' | 'done'
type ClaimStep = 'idle' | 'claiming' | 'done'

function parseOnchainError(error: unknown): string {
  const msg = (error as Error)?.message?.toLowerCase() ?? ''
  if (msg.includes('user rejected') || msg.includes('denied')) return 'Bạn đã huỷ giao dịch.'
  if (msg.includes('insufficient') || msg.includes('exceeds balance')) return 'Không đủ USDC. Hãy lấy test USDC từ sidebar.'
  if (msg.includes('rafflefull')) return 'Vòng xổ số đã đầy!'
  if (msg.includes('reverted')) return 'Giao dịch thất bại. Vui lòng thử lại.'
  return 'Có lỗi xảy ra. Vui lòng thử lại.'
}

export default function App() {
  const { address, isConnected, chainId } = useAccount()
  const { switchChain } = useSwitchChain()
  const isWrongChain = isConnected && chainId !== ARC_TESTNET_ID

  // ── Contract reads ─────────────────────────────────────────────────────────
  const { data: statusData, refetch: refetchStatus } = useReadContract({
    address: RAFFLE_ADDRESS,
    abi: RAFFLE_ABI,
    functionName: 'getRaffleStatus',
    chainId: ARC_TESTNET_ID,
  })

  const { data: participantsData, refetch: refetchParticipants } = useReadContract({
    address: RAFFLE_ADDRESS,
    abi: RAFFLE_ABI,
    functionName: 'getParticipants',
    chainId: ARC_TESTNET_ID,
  })

  const { data: pendingAmount, refetch: refetchPending } = useReadContract({
    address: RAFFLE_ADDRESS,
    abi: RAFFLE_ABI,
    functionName: 'pendingWithdrawals',
    args: address ? [address] : undefined,
    chainId: ARC_TESTNET_ID,
  })

  const { data: usdcAllowance, refetch: refetchAllowance } = useReadContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: 'allowance',
    args: address ? [address, RAFFLE_ADDRESS] : undefined,
    chainId: ARC_TESTNET_ID,
  })

  // ── Parsed state ───────────────────────────────────────────────────────────
  const [currentCount, maxTickets, ticketPrice, potSize] = statusData
    ? (statusData as [bigint, bigint, bigint, bigint])
    : [0n, 10n, 1_000_000n, 0n]

  const decimals = usdcDecimalsFor(ARC_TESTNET_ID)
  const ticketPriceFormatted = Amount.fromRaw(ticketPrice, decimals).toFixed(2)
  const potSizeFormatted = Amount.fromRaw(potSize, decimals).toFixed(2)
  const winnerPrize = Amount.fromRaw(((potSize) * 95n) / 100n, decimals).toFixed(2)
  const pendingFormatted = pendingAmount
    ? Amount.fromRaw(pendingAmount as bigint, decimals).toFixed(2)
    : '0.00'
  const hasPending = pendingAmount ? (pendingAmount as bigint) > 0n : false
  const fillPct = maxTickets > 0n
    ? Math.round((Number(currentCount) / Number(maxTickets)) * 100)
    : 0
  const participants = (participantsData as string[] | undefined) ?? []
  const hasTicket = address ? participants.some(p => p.toLowerCase() === address.toLowerCase()) : false
  const isAlreadyApproved = usdcAllowance ? (usdcAllowance) >= (ticketPrice) : false

  // ── Buy flow ───────────────────────────────────────────────────────────────
  const [buyStep, setBuyStep] = useState<BuyStep>('idle')
  const [approveTxHash, setApproveTxHash] = useState<`0x${string}` | undefined>()
  const [buyTxHash, setBuyTxHash] = useState<`0x${string}` | undefined>()

  const { writeContract: writeApprove, isPending: isApprovePending } = useWriteContract()
  const { writeContract: writeBuy, isPending: isBuyPending } = useWriteContract()

  const { isLoading: isApproveConfirming } = useWaitForTransactionReceipt({
    hash: approveTxHash,
    onReplaced: () => setBuyStep('idle'),
  })

  const { isLoading: isBuyConfirming, isSuccess: isBuySuccess } = useWaitForTransactionReceipt({
    hash: buyTxHash,
  })

  // refetch after buy
  if (isBuySuccess && buyStep === 'buying') {
    setBuyStep('done')
    void refetchStatus()
    void refetchParticipants()
    void refetchPending()
    toast.success('Mua vé thành công! Chúc may mắn!')
  }

  const handleApprove = useCallback(() => {
    if (isWrongChain) { switchChain({ chainId: ARC_TESTNET_ID }); return }
    setBuyStep('approving')
    writeApprove(
      {
        address: USDC_ADDRESS,
        abi: erc20Abi,
        functionName: 'approve',
        args: [RAFFLE_ADDRESS, ticketPrice],
        chainId: ARC_TESTNET_ID,
      },
      {
        onSuccess: (hash) => {
          setApproveTxHash(hash)
          void refetchAllowance().then(() => setBuyStep('approved'))
        },
        onError: (e) => { setBuyStep('idle'); toast.error(parseOnchainError(e)) },
      }
    )
  }, [isWrongChain, switchChain, writeApprove, ticketPrice, refetchAllowance])

  const handleBuy = useCallback(() => {
    if (isWrongChain) { switchChain({ chainId: ARC_TESTNET_ID }); return }
    setBuyStep('buying')
    writeBuy(
      {
        address: RAFFLE_ADDRESS,
        abi: RAFFLE_ABI,
        functionName: 'buyTicket',
        chainId: ARC_TESTNET_ID,
      },
      {
        onSuccess: (hash) => setBuyTxHash(hash),
        onError: (e) => { setBuyStep('idle'); toast.error(parseOnchainError(e)) },
      }
    )
  }, [isWrongChain, switchChain, writeBuy])

  // ── Claim flow ─────────────────────────────────────────────────────────────
  const [claimStep, setClaimStep] = useState<ClaimStep>('idle')
  const [claimTxHash, setClaimTxHash] = useState<`0x${string}` | undefined>()
  const { writeContract: writeClaim, isPending: isClaimPending } = useWriteContract()
  const { isLoading: isClaimConfirming, isSuccess: isClaimSuccess } = useWaitForTransactionReceipt({
    hash: claimTxHash,
  })

  if (isClaimSuccess && claimStep === 'claiming') {
    setClaimStep('done')
    void refetchPending()
    toast.success('Nhận thưởng thành công!')
  }

  const handleClaim = useCallback(() => {
    if (isWrongChain) { switchChain({ chainId: ARC_TESTNET_ID }); return }
    setClaimStep('claiming')
    writeClaim(
      {
        address: RAFFLE_ADDRESS,
        abi: RAFFLE_ABI,
        functionName: 'claimWinnings',
        chainId: ARC_TESTNET_ID,
      },
      {
        onSuccess: (hash) => setClaimTxHash(hash),
        onError: (e) => { setClaimStep('idle'); toast.error(parseOnchainError(e)) },
      }
    )
  }, [isWrongChain, switchChain, writeClaim])

  // ── UI helpers ─────────────────────────────────────────────────────────────
  const getBuyButtonLabel = () => {
    if (!isConnected) return 'Kết nối ví để mua vé'
    if (isWrongChain) return 'Chuyển sang Arc Testnet'
    if (buyStep === 'approving' || isApprovePending || isApproveConfirming) return 'Đang phê duyệt USDC...'
    if (buyStep === 'approved' || isAlreadyApproved) {
      if (buyStep === 'buying' || isBuyPending || isBuyConfirming) return 'Đang mua vé...'
      return 'Mua vé ngay'
    }
    return `Phê duyệt ${ticketPriceFormatted} USDC`
  }
  const isBuyLoading = isApprovePending || isApproveConfirming || isBuyPending || isBuyConfirming
  const canBuy = isConnected && !isWrongChain && !hasTicket && Number(currentCount) < Number(maxTickets)

  return (
    <div
      className="relative min-h-dvh overflow-hidden"
      style={{ background: 'linear-gradient(180deg, #f9f9fc 0%, #fffcf7 52%, #fbf7f2 100%)' }}
    >
      {/* Ambient blobs */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div style={{ position: 'absolute', top: '6%', left: '4%', width: 320, height: 320, borderRadius: '50%', background: 'radial-gradient(circle, rgba(133,177,237,0.20) 0%, transparent 70%)', filter: 'blur(64px)' }} />
        <div style={{ position: 'absolute', bottom: '6%', right: '6%', width: 280, height: 280, borderRadius: '50%', background: 'radial-gradient(circle, rgba(255,205,131,0.18) 0%, transparent 70%)', filter: 'blur(60px)' }} />
        <div style={{ position: 'absolute', top: '50%', right: '10%', width: 200, height: 200, borderRadius: '50%', background: 'radial-gradient(circle, rgba(240,92,107,0.10) 0%, transparent 70%)', filter: 'blur(50px)' }} />
      </div>

      <div className="relative z-10 mx-auto max-w-md px-4 pb-10 pt-6">
        {/* Header */}
        <header className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="display text-xl font-bold" style={{ color: 'var(--ink)' }}>USDC Raffle</h1>
            <p className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>Arc Testnet</p>
          </div>
          <ConnectKitButton />
        </header>

        <main className="space-y-3">
          {/* Hero pot card */}
          <div className="rounded-2xl p-5" style={glassCard}>
            {/* Spectral top strip */}
            <div className="h-1 rounded-full mb-4" style={{ background: 'linear-gradient(90deg, #5fbeff, #af8ff4, #f05c6b, #ffcd83, #7ef1b3)' }} />

            <div className="text-center mb-4">
              <p className="text-xs font-semibold tracking-widest uppercase mb-1" style={{ color: 'var(--muted)' }}>Tổng giải thưởng</p>
              <div className="flex items-baseline justify-center gap-2">
                <span className="display font-bold tabular-nums" style={{ fontSize: 44, color: 'var(--ink)' }}>
                  {potSizeFormatted}
                </span>
                <span className="flex items-center gap-1 font-semibold text-sm" style={{ color: 'var(--muted)' }}>
                  <TokenUSDC variant="branded" size={16} /> USDC
                </span>
              </div>
              <p className="text-sm mt-1 tabular-nums" style={{ color: 'var(--subtle)' }}>
                Người thắng nhận ~<span className="font-semibold" style={{ color: 'var(--success)' }}>{winnerPrize} USDC</span> (95%)
              </p>
            </div>

            {/* Progress bar */}
            <div className="rounded-full h-2 overflow-hidden mb-2" style={{ background: 'var(--surface-muted)' }}>
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${fillPct}%`,
                  background: fillPct >= 80
                    ? 'linear-gradient(90deg, #f05c6b, #ffcd83)'
                    : 'linear-gradient(90deg, #5fbeff, #af8ff4)',
                }}
              />
            </div>
            <div className="flex justify-between text-xs tabular-nums" style={{ color: 'var(--muted)' }}>
              <span className="flex items-center gap-1">
                <Users size={12} />
                {String(currentCount)} / {String(maxTickets)} vé
              </span>
              <span>{fillPct}% đã bán</span>
            </div>
          </div>

          {/* Ticket info row */}
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl p-4" style={glassCard}>
              <p className="text-xs font-medium mb-1" style={{ color: 'var(--muted)' }}>Giá vé</p>
              <div className="flex items-center gap-1.5">
                <TokenUSDC variant="branded" size={18} />
                <span className="display font-bold tabular-nums" style={{ color: 'var(--ink)', fontSize: 20 }}>
                  {ticketPriceFormatted}
                </span>
              </div>
            </div>
            <div className="rounded-xl p-4" style={glassCard}>
              <p className="text-xs font-medium mb-1" style={{ color: 'var(--muted)' }}>Còn lại</p>
              <div className="flex items-center gap-1.5">
                <Ticket size={18} color="var(--accent)" />
                <span className="display font-bold tabular-nums" style={{ color: 'var(--ink)', fontSize: 20 }}>
                  {String(Number(maxTickets) - Number(currentCount))}
                </span>
                <span className="text-xs" style={{ color: 'var(--subtle)' }}>vé</span>
              </div>
            </div>
          </div>

          {/* Already has ticket */}
          {hasTicket && (
            <div className="rounded-xl px-4 py-3 flex items-center gap-2" style={{ ...glassInner, border: '1px solid rgba(26,128,71,0.25)' }}>
              <CheckCircle2 size={16} color="var(--success)" />
              <p className="text-sm font-medium" style={{ color: 'var(--success)' }}>Bạn đã có vé trong vòng này!</p>
            </div>
          )}

          {/* Wrong chain banner */}
          {isWrongChain && (
            <div className="rounded-xl px-4 py-3 flex items-center gap-2" style={{ ...glassInner, border: '1px solid rgba(186,43,76,0.25)' }}>
              <AlertCircle size={16} color="var(--danger)" />
              <p className="text-sm" style={{ color: 'var(--danger)' }}>Vui lòng chuyển sang <b>Arc Testnet</b></p>
            </div>
          )}

          {/* Buy ticket card */}
          {!hasTicket && (
            <div className="rounded-2xl p-5" style={glassCard}>
              <h2 className="display font-bold text-base mb-4" style={{ color: 'var(--ink)' }}>Mua vé xổ số</h2>

              <div className="rounded-xl p-4 mb-4" style={glassInner}>
                <div className="flex items-center justify-between">
                  <span className="text-sm" style={{ color: 'var(--muted)' }}>Bạn trả</span>
                  <div className="flex items-center gap-1.5">
                    <TokenUSDC variant="branded" size={16} />
                    <span className="font-bold tabular-nums" style={{ color: 'var(--ink)' }}>{ticketPriceFormatted} USDC</span>
                  </div>
                </div>
                <div className="flex items-center justify-between mt-2">
                  <span className="text-sm" style={{ color: 'var(--muted)' }}>Cơ hội thắng</span>
                  <span className="font-semibold tabular-nums" style={{ color: 'var(--accent)' }}>
                    1 / {String(maxTickets)}
                  </span>
                </div>
                <div className="flex items-center justify-between mt-2">
                  <span className="text-sm" style={{ color: 'var(--muted)' }}>Giải thưởng tối đa</span>
                  <span className="font-semibold tabular-nums" style={{ color: 'var(--success)' }}>
                    {Amount.fromRaw(((ticketPrice) * (maxTickets) * 95n) / 100n, decimals).toFixed(2)} USDC
                  </span>
                </div>
              </div>

              {/* Two-step buy: approve then buy */}
              {!isAlreadyApproved && buyStep !== 'approved' ? (
                <button
                  className="w-full rounded-xl py-3.5 font-semibold text-sm flex items-center justify-center gap-2 transition-all"
                  style={{
                    background: canBuy ? 'var(--accent)' : 'var(--surface-muted)',
                    color: canBuy ? 'white' : 'var(--subtle)',
                    cursor: canBuy ? 'pointer' : 'not-allowed',
                    minHeight: 48,
                  }}
                  onClick={canBuy && !isBuyLoading ? handleApprove : undefined}
                  disabled={!canBuy || isBuyLoading}
                >
                  {(isApprovePending || isApproveConfirming) && <Loader2 size={16} className="animate-spin" />}
                  {getBuyButtonLabel()}
                </button>
              ) : (
                <button
                  className="w-full rounded-xl py-3.5 font-semibold text-sm flex items-center justify-center gap-2 transition-all"
                  style={{
                    background: canBuy ? 'var(--accent)' : 'var(--surface-muted)',
                    color: canBuy ? 'white' : 'var(--subtle)',
                    cursor: canBuy ? 'pointer' : 'not-allowed',
                    minHeight: 48,
                  }}
                  onClick={canBuy && !isBuyLoading ? handleBuy : undefined}
                  disabled={!canBuy || isBuyLoading}
                >
                  {(isBuyPending || isBuyConfirming) && <Loader2 size={16} className="animate-spin" />}
                  {isBuySuccess || buyStep === 'done'
                    ? <><CheckCircle2 size={16} /> Đã mua vé!</>
                    : getBuyButtonLabel()
                  }
                </button>
              )}

              {/* Tx links */}
              {approveTxHash && (
                <a
                  href={buildTxExplorerUrl(ARC_TESTNET_ID, approveTxHash)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block mt-2 text-center text-xs underline"
                  style={{ color: 'var(--subtle)' }}
                >
                  Xem tx phê duyệt trên explorer
                </a>
              )}
              {buyTxHash && (
                <a
                  href={buildTxExplorerUrl(ARC_TESTNET_ID, buyTxHash)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block mt-2 text-center text-xs underline"
                  style={{ color: 'var(--subtle)' }}
                >
                  Xem tx mua vé trên explorer
                </a>
              )}
            </div>
          )}

          {/* Claim winnings */}
          {hasPending && (
            <div className="rounded-2xl p-5" style={{ ...glassCard, border: '1px solid rgba(26,128,71,0.3)' }}>
              <div className="flex items-center gap-2 mb-3">
                <Trophy size={20} color="var(--success)" />
                <h2 className="display font-bold text-base" style={{ color: 'var(--success)' }}>Bạn thắng rồi!</h2>
              </div>
              <div className="rounded-xl p-3 mb-4 flex items-center justify-between" style={glassInner}>
                <span className="text-sm" style={{ color: 'var(--muted)' }}>Phần thưởng của bạn</span>
                <div className="flex items-center gap-1.5">
                  <TokenUSDC variant="branded" size={16} />
                  <span className="font-bold tabular-nums" style={{ color: 'var(--success)' }}>{pendingFormatted} USDC</span>
                </div>
              </div>
              <button
                className="w-full rounded-xl py-3.5 font-semibold text-sm flex items-center justify-center gap-2 transition-all"
                style={{ background: 'var(--success)', color: 'white', minHeight: 48 }}
                onClick={claimStep === 'idle' ? handleClaim : undefined}
                disabled={claimStep !== 'idle' || isClaimPending || isClaimConfirming}
              >
                {(isClaimPending || isClaimConfirming) && <Loader2 size={16} className="animate-spin" />}
                {isClaimSuccess || claimStep === 'done'
                  ? <><CheckCircle2 size={16} /> Đã nhận thưởng!</>
                  : <><Gift size={16} /> Nhận thưởng ngay</>
                }
              </button>
              {claimTxHash && (
                <a
                  href={buildTxExplorerUrl(ARC_TESTNET_ID, claimTxHash)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block mt-2 text-center text-xs underline"
                  style={{ color: 'var(--subtle)' }}
                >
                  Xem tx nhận thưởng trên explorer
                </a>
              )}
            </div>
          )}

          {/* Participants list */}
          {participants.length > 0 && (
            <div className="rounded-2xl p-5" style={glassCard}>
              <div className="flex items-center justify-between mb-3">
                <h2 className="display font-bold text-sm" style={{ color: 'var(--ink)' }}>
                  Người tham gia ({participants.length})
                </h2>
                <button
                  onClick={() => { void refetchStatus(); void refetchParticipants(); void refetchPending() }}
                  className="rounded-lg p-1.5 transition-all"
                  style={glassInner}
                  title="Làm mới"
                >
                  <RefreshCw size={14} color="var(--subtle)" />
                </button>
              </div>
              <div className="space-y-1.5">
                {participants.map((addr, i) => (
                  <div
                    key={addr + i}
                    className="flex items-center gap-2 rounded-lg px-3 py-2"
                    style={{
                      ...glassInner,
                      background: address && addr.toLowerCase() === address.toLowerCase()
                        ? 'rgba(133,177,237,0.18)' : 'rgba(255,255,255,0.46)',
                    }}
                  >
                    <span className="text-xs mono" style={{ color: 'var(--subtle)' }}>#{i + 1}</span>
                    <span className="mono text-xs flex-1 truncate" style={{ color: 'var(--ink-2)' }}>
                      {addr.slice(0, 10)}...{addr.slice(-6)}
                    </span>
                    {address && addr.toLowerCase() === address.toLowerCase() && (
                      <span className="text-xs font-semibold rounded-full px-2 py-0.5" style={{ background: 'rgba(133,177,237,0.3)', color: 'var(--accent)' }}>Bạn</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Info footer */}
          <div className="rounded-xl px-4 py-3 flex items-start gap-2" style={glassInner}>
            <AlertCircle size={14} color="var(--subtle)" className="mt-0.5 shrink-0" />
            <p className="text-xs leading-relaxed" style={{ color: 'var(--subtle)' }}>
              Xổ số tự động quay khi đủ {String(maxTickets)} vé. Người thắng nhận 95%, phí nền tảng 5%.
              Dự án học tập trên {chain.name} — RNG không an toàn cho mainnet thật.
            </p>
          </div>
        </main>
      </div>
    </div>
  )
}
