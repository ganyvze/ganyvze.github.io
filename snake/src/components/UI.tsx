/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import { useGameStore } from '../store/gameStore';
import { motion, AnimatePresence } from 'framer-motion';
import { Trophy, MousePointer2, Zap, RotateCcw, Skull } from 'lucide-react';

export function UI() {
  const { isDead, playerScore, leaderboard, restartGame } = useGameStore();

  return (
    <div className="absolute inset-0 pointer-events-none flex flex-col justify-between p-4 z-20">
      {/* Top Bar */}
      <div className="flex justify-between items-start pointer-events-auto relative">
        {/* Left: Player Length Display */}
        <div className="flex flex-col gap-0.5 z-10 select-none bg-black/50 backdrop-blur-md px-4 py-2 rounded-2xl border border-white/10 shadow-lg">
          <span className="text-[11px] text-white/50 font-bold tracking-wider uppercase">我的体长</span>
          <div className="flex items-baseline gap-1">
            <span className="text-3xl font-mono text-yellow-400 font-black drop-shadow-[0_0_12px_rgba(250,204,21,0.6)]">
              {playerScore}
            </span>
            <span className="text-xs text-white/40 font-mono">节</span>
          </div>
        </div>
        
        {/* Center: Controls Hint */}
        <div className="absolute left-1/2 -translate-x-1/2 top-0 flex gap-3 opacity-90 pointer-events-none hidden sm:flex select-none">
          <div className="flex items-center gap-2 text-xs font-mono text-white bg-black/60 px-3.5 py-1.5 rounded-full backdrop-blur-md border border-cyan-500/30 shadow-[0_0_15px_rgba(6,182,212,0.2)]">
            <MousePointer2 size={13} className="text-cyan-400" />
            <span className="font-bold text-cyan-300">移动鼠标</span>
            <span className="text-white/60 text-[11px]">控制方向</span>
          </div>
          <div className="flex items-center gap-2 text-xs font-mono text-white bg-black/60 px-3.5 py-1.5 rounded-full backdrop-blur-md border border-pink-500/30 shadow-[0_0_15px_rgba(236,72,153,0.2)]">
            <Zap size={13} className="text-pink-400" />
            <span className="font-bold text-pink-300">左键 / 空格</span>
            <span className="text-white/60 text-[11px]">冲刺加速</span>
          </div>
        </div>

        {/* Right: Leaderboard */}
        {leaderboard.length > 0 && (
          <div className="w-56 bg-black/60 backdrop-blur-md rounded-2xl p-3.5 border border-white/10 pointer-events-auto shadow-2xl select-none">
            <div className="flex items-center justify-between mb-2.5 border-b border-white/10 pb-1.5">
              <div className="flex items-center gap-2 text-white/90 font-bold text-xs">
                <Trophy size={15} className="text-yellow-400" />
                <span>实时排行榜</span>
              </div>
              <span className="text-[10px] text-white/40 font-mono">共10条</span>
            </div>
            <div className="flex flex-col gap-1">
              {leaderboard.map((entry, i) => {
                const isCurrentPlayer = entry.id === 'player' || entry.name === '我';
                return (
                  <div
                    key={entry.id}
                    className={`flex justify-between items-center text-xs py-0.5 px-1.5 rounded-lg transition-colors ${
                      isCurrentPlayer ? 'bg-cyan-500/20 border border-cyan-500/40 font-bold' : ''
                    }`}
                  >
                    <div className="flex items-center gap-2 truncate">
                      <span className={`w-4 text-center font-mono text-[11px] ${
                        i === 0 ? 'text-yellow-400 font-bold' : i === 1 ? 'text-slate-300' : i === 2 ? 'text-amber-500' : 'text-white/40'
                      }`}>
                        {i + 1}
                      </span>
                      <span
                        style={{ color: isCurrentPlayer ? '#00f5d4' : entry.color }}
                        className="truncate max-w-[105px] drop-shadow-sm font-medium"
                      >
                        {entry.name}
                        {isCurrentPlayer && <span className="text-[10px] text-cyan-300 font-normal ml-1">(我)</span>}
                      </span>
                    </div>
                    <span className="font-mono text-white/90 font-semibold text-[11px]">{entry.score}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Death Modal Only */}
      <AnimatePresence>
        {isDead && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="absolute inset-0 flex items-center justify-center pointer-events-auto bg-black/75 backdrop-blur-md z-30 p-4 select-none"
          >
            <div className="bg-zinc-950/95 p-8 rounded-3xl border border-red-500/30 shadow-[0_0_50px_rgba(239,68,68,0.3)] max-w-sm w-full flex flex-col items-center gap-6">
              <div className="text-center w-full">
                <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-red-500/10 border border-red-500/40 text-red-400 mb-3 animate-pulse">
                  <Skull size={32} />
                </div>
                <h2 className="text-4xl font-black text-transparent bg-clip-text bg-gradient-to-r from-red-500 via-pink-500 to-amber-500 mb-2 tracking-tight">
                  你已阵亡
                </h2>
                <p className="text-white/70 text-sm">
                  最终体长：<span className="text-yellow-400 font-mono font-black text-2xl">{playerScore}</span>
                </p>
              </div>

              <button
                onClick={restartGame}
                className="w-full py-4 bg-gradient-to-r from-cyan-400 via-blue-500 to-indigo-500 hover:from-cyan-300 hover:to-blue-400 text-black font-black rounded-2xl transition-all active:scale-95 shadow-[0_0_25px_rgba(6,182,212,0.5)] cursor-pointer text-base tracking-wider flex items-center justify-center gap-2"
              >
                <RotateCcw size={18} className="text-black" />
                <span>重新开始</span>
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
