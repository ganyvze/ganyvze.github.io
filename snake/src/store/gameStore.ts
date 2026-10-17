/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import { create } from 'zustand';
import { LeaderboardEntry } from '../shared/types';

interface GameStore {
  isDead: boolean;
  playerScore: number;
  leaderboard: LeaderboardEntry[];
  restartCount: number;
  setPlayerDead: (finalScore: number) => void;
  restartGame: () => void;
  updateLeaderboard: (leaderboard: LeaderboardEntry[], score: number) => void;
}

export const useGameStore = create<GameStore>((set) => ({
  isDead: false,
  playerScore: 12,
  leaderboard: [],
  restartCount: 0,
  setPlayerDead: (finalScore: number) => set({ isDead: true, playerScore: Math.floor(finalScore) }),
  restartGame: () => set((state) => ({ isDead: false, restartCount: state.restartCount + 1 })),
  updateLeaderboard: (leaderboard: LeaderboardEntry[], score: number) =>
    set({ leaderboard, playerScore: Math.floor(score) }),
}));
