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
  ExternalLink
} from 'lucide-react';

interface OrderItem {
  id: number;
  type: 'LIMIT' | 'STOP_LOSS';
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  minAmountOut: string;
  bountyBps: number;
  status: 'Active' | 'Executed' | 'Cancelled';
}

export default function App() {
  const [walletConnected, setWalletConnected] = useState(false);
  const [walletAddress, setWalletAddress] = useState('');
  
  const [orders] = useState<OrderItem[]>([
    {
      id: 1,
      type: 'LIMIT',
      tokenIn: 'XLM',
      tokenOut: 'USDC',
      amountIn: '500.00',
      minAmountOut: '95.00',
      bountyBps: 50,
      status: 'Active',
    },
    {
      id: 2,
      type: 'STOP_LOSS',
      tokenIn: 'XLM',
      tokenOut: 'EURC',
      amountIn: '1,200.00',
      minAmountOut: '190.00',
      bountyBps: 100,
      status: 'Executed',
    }
  ]);

  const handleConnectWallet = async () => {
    setWalletAddress('GBBD...4X9Z');
    setWalletConnected(true);
  };

  return (
    <div className="min-h-screen bg-[#0B0E14] text-slate-100 p-6 md:p-10">
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

        <button
          onClick={handleConnectWallet}
          className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[#131822] hover:bg-[#1D2433] border border-[#273142] text-sm font-medium transition-all shadow-sm"
        >
          <Wallet className="w-4 h-4 text-[#00F0FF]" />
          {walletConnected ? walletAddress : 'Connect Freighter'}
        </button>
      </header>

      <main className="max-w-6xl mx-auto mt-8 space-y-8">
        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-[#131822] border border-[#273142] p-5 rounded-xl">
            <div className="flex justify-between items-center text-slate-400 text-xs font-medium">
              <span>ACTIVE VAULT VALUE</span>
              <Coins className="w-4 h-4 text-blue-400" />
            </div>
            <div className="text-2xl font-bold mt-2 text-white">$14,250.00</div>
            <div className="text-xs text-emerald-400 mt-1 flex items-center gap-1">
              <span>● Fully Collateralized</span>
            </div>
          </div>

          <div className="bg-[#131822] border border-[#273142] p-5 rounded-xl">
            <div className="flex justify-between items-center text-slate-400 text-xs font-medium">
              <span>EXECUTED ORDERS</span>
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            </div>
            <div className="text-2xl font-bold mt-2 text-white">42</div>
            <div className="text-xs text-slate-400 mt-1">100% Slippage Protected</div>
          </div>

          <div className="bg-[#131822] border border-[#273142] p-5 rounded-xl">
            <div className="flex justify-between items-center text-slate-400 text-xs font-medium">
              <span>KEEPER INCENTIVE POOL</span>
              <Zap className="w-4 h-4 text-amber-400" />
            </div>
            <div className="text-2xl font-bold mt-2 text-white">185.40 XLM</div>
            <div className="text-xs text-slate-400 mt-1">Distributed to Keepers</div>
          </div>

          <div className="bg-[#131822] border border-[#273142] p-5 rounded-xl">
            <div className="flex justify-between items-center text-slate-400 text-xs font-medium">
              <span>ROUTER STATUS</span>
              <ArrowRightLeft className="w-4 h-4 text-cyan-400" />
            </div>
            <div className="text-2xl font-bold mt-2 text-white">Soroswap V1</div>
            <div className="text-xs text-emerald-400 mt-1 flex items-center gap-1">
              <span>Online & Routing</span>
            </div>
          </div>
        </section>

        <div className="flex justify-between items-center pt-2">
          <h2 className="text-lg font-semibold text-white">Your Orders & Automation</h2>
          <button className="flex items-center gap-2 bg-[#3E7BFA] hover:bg-blue-600 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-all shadow-md shadow-blue-500/20">
            <PlusCircle className="w-4 h-4" />
            Create Limit Order
          </button>
        </div>

        <div className="bg-[#131822] border border-[#273142] rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-[#1D2433] text-slate-400 text-xs uppercase tracking-wider border-b border-[#273142]">
                <tr>
                  <th className="px-6 py-4">ID & Type</th>
                  <th className="px-6 py-4">Pair (In / Out)</th>
                  <th className="px-6 py-4">Amount In</th>
                  <th className="px-6 py-4">Min Amount Out</th>
                  <th className="px-6 py-4">Keeper Bounty</th>
                  <th className="px-6 py-4">Status</th>
                  <th className="px-6 py-4 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#273142]">
                {orders.map((o) => (
                  <tr key={o.id} className="hover:bg-[#18202F]/60 transition-colors">
                    <td className="px-6 py-4 font-mono font-medium text-white flex items-center gap-2">
                      #{o.id}
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                        o.type === 'LIMIT' ? 'bg-blue-900/60 text-blue-300' : 'bg-amber-900/60 text-amber-300'
                      }`}>
                        {o.type}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <div className="font-semibold text-white">{o.tokenIn} → {o.tokenOut}</div>
                    </td>
                    <td className="px-6 py-4 text-slate-300">{o.amountIn} {o.tokenIn}</td>
                    <td className="px-6 py-4 text-slate-300 font-mono">≥ {o.minAmountOut} {o.tokenOut}</td>
                    <td className="px-6 py-4 text-slate-300">{o.bountyBps / 100}%</td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium ${
                        o.status === 'Active' 
                          ? 'bg-emerald-950 text-emerald-400 border border-emerald-800' 
                          : 'bg-slate-800 text-slate-400 border border-slate-700'
                      }`}>
                        {o.status === 'Active' ? <Clock className="w-3 h-3" /> : <CheckCircle2 className="w-3 h-3" />}
                        {o.status}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-right">
                      {o.status === 'Active' ? (
                        <button className="text-xs text-rose-400 hover:text-rose-300 font-medium transition-colors">
                          Cancel
                        </button>
                      ) : (
                        <span className="text-xs text-slate-500 flex items-center justify-end gap-1">
                          Settled <ExternalLink className="w-3 h-3" />
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </div>
  );
}
