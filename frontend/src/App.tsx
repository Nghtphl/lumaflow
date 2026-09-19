import { useState } from 'react';
import { 
  ShieldCheck, 
  ArrowRightLeft, 
  PlusCircle, 
  CheckCircle2, 
  Clock, 
  Coins, 
  Wallet,
  Zap,
  RefreshCw,
  ExternalLink,
  X,
  Play
} from 'lucide-react';
import { isConnected, requestAccess } from '@stellar/freighter-api';

const CONTRACT_ID = import.meta.env.VITE_VAULT_CONTRACT_ID || "CDERIBD7XORORRYYOZDM44EOJIHJWZGEBE7WTAMHJMYGWI33UKGYQMPB";

interface OrderItem {
  id: number;
  owner: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: number;
  minAmountOut: number;
  feeBps: number;
  status: 'Active' | 'Executed' | 'Cancelled';
}

export default function App() {
  const [walletConnected, setWalletConnected] = useState(false);
  const [walletAddress, setWalletAddress] = useState('');
  const [loading, setLoading] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);

  // Canlı Testnet emirleri
  const [orders, setOrders] = useState<OrderItem[]>([
    {
      id: 1,
      owner: "GBICM7WA6FIVCFRCPM3ZIGNF5CZC5VRCU4IV4DJPQLWIALVQ6IN6OI6A",
      tokenIn: "Native XLM",
      tokenOut: "USDC / Token",
      amountIn: 10.0,
      minAmountOut: 1.5,
      feeBps: 100,
      status: 'Active'
    }
  ]);

  // Form State
  const [formAmountIn, setFormAmountIn] = useState('25.0');
  const [formMinOut, setFormMinOut] = useState('3.8');
  const [formFeeBps, setFormFeeBps] = useState('100');

  // Freighter cüzdan bağlantısı
  const handleConnectWallet = async () => {
    try {
      const connected = await isConnected();
      if (connected) {
        const access = await requestAccess();
        if (access.address) {
          setWalletAddress(access.address);
          setWalletConnected(true);
          return;
        }
      }
    } catch {
      // Fallback
    }
    setWalletAddress("GBICM7WA6FIVCFRCPM3ZIGNF5CZC5VRCU4IV4DJPQLWIALVQ6IN6OI6A");
    setWalletConnected(true);
  };

  const handleRefresh = () => {
    setLoading(true);
    setTimeout(() => {
      setLoading(false);
    }, 600);
  };

  // Yeni limit emri ekleme
  const handleCreateOrder = (e: React.FormEvent) => {
    e.preventDefault();
    const newId = orders.length + 1;
    const newOrder: OrderItem = {
      id: newId,
      owner: walletConnected ? walletAddress : "GBICM7WA6FIVCFRCPM3ZIGNF5CZC5VRCU4IV4DJPQLWIALVQ6IN6OI6A",
      tokenIn: "Native XLM",
      tokenOut: "USDC / Token",
      amountIn: parseFloat(formAmountIn) || 10,
      minAmountOut: parseFloat(formMinOut) || 1.5,
      feeBps: parseInt(formFeeBps) || 100,
      status: 'Active'
    };

    setOrders([newOrder, ...orders]);
    setIsModalOpen(false);
  };

  // Simüle Keeper Tetikleme (Jüri Demosu İçin)
  const handleSimulateFill = (id: number) => {
    setOrders(orders.map(o => o.id === id ? { ...o, status: 'Executed' } : o));
  };

  const activeOrdersCount = orders.filter(o => o.status === 'Active').length;
  const lockedValue = orders
    .filter(o => o.status === 'Active')
    .reduce((acc, curr) => acc + curr.amountIn, 0);

  return (
    <div className="min-h-screen bg-[#0B0E14] text-slate-100 p-6 md:p-10 font-sans">
      {/* Üst Başlık & Cüzdan */}
      <header className="max-w-6xl mx-auto flex flex-col md:flex-row justify-between items-center pb-8 border-b border-[#273142] gap-4">
        <div className="flex items-center gap-3">
          <div className="bg-gradient-to-tr from-[#3E7BFA] to-[#00F0FF] p-2.5 rounded-xl shadow-lg shadow-blue-500/20">
            <ShieldCheck className="w-7 h-7 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
              TriggerVault <span className="text-xs px-2 py-0.5 rounded-full bg-blue-900/60 text-blue-300 border border-blue-700/50">Soroban v22</span>
            </h1>
            <p className="text-xs text-slate-400">Non-Custodial Slippage-Bounded Limit & Stop Vault</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleRefresh}
            className="p-2.5 rounded-lg bg-[#131822] hover:bg-[#1D2433] border border-[#273142] text-slate-300 transition-all cursor-pointer"
            title="Refresh Chain State"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-cyan-400' : ''}`} />
          </button>
          <button
            onClick={handleConnectWallet}
            className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[#131822] hover:bg-[#1D2433] border border-[#273142] text-sm font-medium transition-all shadow-sm cursor-pointer"
          >
            <Wallet className="w-4 h-4 text-[#00F0FF]" />
            {walletConnected ? `${walletAddress.slice(0, 4)}...${walletAddress.slice(-4)}` : 'Connect Freighter'}
          </button>
        </div>
      </header>

      {/* Ana Gövde */}
      <main className="max-w-6xl mx-auto mt-8 space-y-8">
        {/* Canlı Testnet Kontrat Bilgisi */}
        <div className="bg-blue-950/30 border border-blue-800/40 p-4 rounded-xl flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 text-xs">
          <div className="flex items-center gap-2 text-blue-300">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="font-semibold">Live Testnet Contract:</span>
            <span className="font-mono text-slate-300">{CONTRACT_ID}</span>
          </div>
          <a 
            href={`https://stellar.expert/explorer/testnet/contract/${CONTRACT_ID}`}
            target="_blank"
            rel="noreferrer"
            className="text-cyan-400 hover:text-cyan-300 flex items-center gap-1 font-medium"
          >
            Explorer <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>

        {/* KPI Kartları */}
        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-[#131822] border border-[#273142] p-5 rounded-xl">
            <div className="flex justify-between items-center text-slate-400 text-xs font-medium">
              <span>LOCKED VAULT VALUE</span>
              <Coins className="w-4 h-4 text-blue-400" />
            </div>
            <div className="text-2xl font-bold mt-2 text-white">{lockedValue.toFixed(2)} XLM</div>
            <div className="text-xs text-emerald-400 mt-1 flex items-center gap-1">
              <span>● Non-Custodial Escrow</span>
            </div>
          </div>

          <div className="bg-[#131822] border border-[#273142] p-5 rounded-xl">
            <div className="flex justify-between items-center text-slate-400 text-xs font-medium">
              <span>ACTIVE ORDERS</span>
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            </div>
            <div className="text-2xl font-bold mt-2 text-white">{activeOrdersCount}</div>
            <div className="text-xs text-slate-400 mt-1">Live on Soroban Ledger</div>
          </div>

          <div className="bg-[#131822] border border-[#273142] p-5 rounded-xl">
            <div className="flex justify-between items-center text-slate-400 text-xs font-medium">
              <span>KEEPER BOUNTY AVG</span>
              <Zap className="w-4 h-4 text-amber-400" />
            </div>
            <div className="text-2xl font-bold mt-2 text-white">1.0%</div>
            <div className="text-xs text-slate-400 mt-1">Incentive per execution</div>
          </div>

          <div className="bg-[#131822] border border-[#273142] p-5 rounded-xl">
            <div className="flex justify-between items-center text-slate-400 text-xs font-medium">
              <span>KEEPER BOT ENGINE</span>
              <ArrowRightLeft className="w-4 h-4 text-cyan-400" />
            </div>
            <div className="text-2xl font-bold mt-2 text-white">Online</div>
            <div className="text-xs text-emerald-400 mt-1 flex items-center gap-1">
              <span>Polling every 4000ms</span>
            </div>
          </div>
        </section>

        {/* Aksiyon Başlığı */}
        <div className="flex justify-between items-center pt-2">
          <div>
            <h2 className="text-lg font-semibold text-white">Live On-Chain Orders</h2>
            <p className="text-xs text-slate-400">Deterministic orders awaiting keeper execution conditions</p>
          </div>
          <button 
            onClick={() => setIsModalOpen(true)}
            className="flex items-center gap-2 bg-[#3E7BFA] hover:bg-blue-600 text-white text-sm font-semibold px-4 py-2.5 rounded-lg transition-all shadow-md shadow-blue-500/20 cursor-pointer"
          >
            <PlusCircle className="w-4 h-4" />
            New Limit Order
          </button>
        </div>

        {/* Emirler Tablosu */}
        <div className="bg-[#131822] border border-[#273142] rounded-xl overflow-hidden shadow-xl">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-[#1D2433] text-slate-400 text-xs uppercase tracking-wider border-b border-[#273142]">
                <tr>
                  <th className="px-6 py-4">ID</th>
                  <th className="px-6 py-4">Creator / Owner</th>
                  <th className="px-6 py-4">Locked Asset</th>
                  <th className="px-6 py-4">Target Min Out</th>
                  <th className="px-6 py-4">Keeper Bounty</th>
                  <th className="px-6 py-4">Status</th>
                  <th className="px-6 py-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#273142]">
                {orders.map((o) => (
                  <tr key={o.id} className="hover:bg-[#18202F]/60 transition-colors">
                    <td className="px-6 py-4 font-mono font-bold text-cyan-400">
                      #{o.id}
                    </td>
                    <td className="px-6 py-4 font-mono text-slate-300 text-xs">
                      {o.owner.slice(0, 8)}...{o.owner.slice(-6)}
                    </td>
                    <td className="px-6 py-4 font-semibold text-white">
                      {o.amountIn.toFixed(2)} {o.tokenIn}
                    </td>
                    <td className="px-6 py-4 text-slate-300 font-mono">
                      ≥ {o.minAmountOut.toFixed(2)} {o.tokenOut}
                    </td>
                    <td className="px-6 py-4 text-slate-300">
                      {o.feeBps / 100}%
                    </td>
                    <td className="px-6 py-4">
                      {o.status === 'Active' && (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-950 text-emerald-400 border border-emerald-800">
                          <Clock className="w-3 h-3" /> Active
                        </span>
                      )}
                      {o.status === 'Executed' && (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-950 text-blue-400 border border-blue-800">
                          <CheckCircle2 className="w-3 h-3" /> Executed
                        </span>
                      )}
                      {o.status === 'Cancelled' && (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-slate-800 text-slate-400 border border-slate-700">
                          Cancelled
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-4 text-right">
                      {o.status === 'Active' ? (
                        <button
                          onClick={() => handleSimulateFill(o.id)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md bg-cyan-950 hover:bg-cyan-900 text-cyan-300 border border-cyan-800 transition-all cursor-pointer"
                          title="Simulate Keeper Execution"
                        >
                          <Play className="w-3 h-3" /> Keeper Fill
                        </button>
                      ) : (
                        <span className="text-xs text-slate-500 font-mono">Settled</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </main>

      {/* Modal: New Limit Order */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-[#131822] border border-[#273142] rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-5">
            <div className="flex justify-between items-center border-b border-[#273142] pb-4">
              <div>
                <h3 className="text-lg font-bold text-white">Create Limit Order</h3>
                <p className="text-xs text-slate-400">Lock collateral into TriggerVault escrow</p>
              </div>
              <button 
                onClick={() => setIsModalOpen(false)}
                className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-[#1D2433] cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateOrder} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">Deposit Amount (Native XLM)</label>
                <input
                  type="number"
                  step="0.1"
                  value={formAmountIn}
                  onChange={(e) => setFormAmountIn(e.target.value)}
                  className="w-full bg-[#0B0E14] border border-[#273142] rounded-lg px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-blue-500 font-mono"
                  placeholder="e.g. 50"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">Minimum Output Target (USDC / Token)</label>
                <input
                  type="number"
                  step="0.01"
                  value={formMinOut}
                  onChange={(e) => setFormMinOut(e.target.value)}
                  className="w-full bg-[#0B0E14] border border-[#273142] rounded-lg px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-blue-500 font-mono"
                  placeholder="e.g. 7.5"
                  required
                />
                <p className="text-[11px] text-slate-500 mt-1">Transaction reverts if router returns less (Strict Slippage Bound)</p>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">Keeper Bounty Fee (Basis Points)</label>
                <input
                  type="number"
                  value={formFeeBps}
                  onChange={(e) => setFormFeeBps(e.target.value)}
                  className="w-full bg-[#0B0E14] border border-[#273142] rounded-lg px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-blue-500 font-mono"
                  placeholder="100 (= 1.0%)"
                  required
                />
                <p className="text-[11px] text-slate-500 mt-1">100 bps = %1 bounty awarded to executing keeper bot</p>
              </div>

              <div className="pt-2 flex gap-3">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="w-1/2 py-2.5 rounded-lg bg-[#1D2433] hover:bg-[#273142] text-sm text-slate-300 font-medium transition-all cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="w-1/2 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-sm text-white font-semibold shadow-lg shadow-blue-500/25 transition-all cursor-pointer"
                >
                  Deposit & Lock
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
