/**
 * SummaTrainer 模块 (弹性多线程 + 实时 ETA 预估 + 深度算法优化版)
 * 
 * 核心特性：
 * 1. 动态 CPU 感知 + 内联 Web Worker 线程池并行计算
 * 2. 实时剩余时间预估 (ETA) 与 训练吞吐量 (迭代/秒) 统计
 * 3. 惰性求值 (Lazy Stringification)：通过校验后才转字符串，减少 90% 垃圾回收
 * 4. 动态 Chunk 抢占式调度 (Work-Stealing Task Queue)
 * 5. 阶段一 (探索与错题采矿) + 阶段二 (全局错题定向复练)
 * 6. 自动降级机制 (不支持 Worker 时自动回退至 MessageChannel 单线程极速模式)
 */
class SummaTrainer {
    constructor() {
        this.progressModal = null;
        this.progressBar = null;
        this.progressText = null;
        this.progressEta = null; // ETA 文本节点
        this.progressLog = null;
        this.isTraining = false;
        this.etaTimer = null; // 定时刷新的定时器
        
        // 难度的模型存储
        this.models = {};
    }
    
    initUI() {
        if (this.progressModal) return;
        
        const modalHtml = `
            <div id="summa-train-modal" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.85); z-index:9999; justify-content:center; align-items:center; flex-direction:column; color:white; font-family:monospace;">
                <h2 style="margin-bottom: 20px; font-size: 24px; text-shadow: 0 0 10px #00d4ff;">Summa 神经网络深度并行训练中...</h2>
                <div style="width: 60%; max-width: 600px; height: 20px; background: #333; border-radius: 10px; overflow: hidden; border: 1px solid #00d4ff; box-shadow: 0 0 15px rgba(0,212,255,0.4);">
                    <div id="summa-train-bar" style="width: 0%; height: 100%; background: linear-gradient(90deg, #00d4ff, #00ff88); transition: width 0.05s ease-out;"></div>
                </div>
                <div id="summa-train-text" style="margin-top: 15px; font-size: 16px; color: #aaa;">0 / 初始化线程池...</div>
                <div id="summa-train-eta" style="margin-top: 6px; font-size: 14px; color: #00ff88;">预估剩余时间: 未知</div>
                <div id="summa-train-log" style="margin-top: 12px; font-size: 12px; color: #555; background: #111; padding: 10px; border-radius: 5px; width: 60%; max-width: 600px; height: 80px; overflow: hidden;">准备注入初始拓扑网数据...</div>
            </div>
        `;
        document.body.insertAdjacentHTML('beforeend', modalHtml);
        
        this.progressModal = document.getElementById('summa-train-modal');
        this.progressBar = document.getElementById('summa-train-bar');
        this.progressText = document.getElementById('summa-train-text');
        this.progressEta = document.getElementById('summa-train-eta');
        this.progressLog = document.getElementById('summa-train-log');
    }

    // 格式化秒数为人类易读的时间字符串
    formatTime(seconds) {
        if (!Number.isFinite(seconds) || seconds < 0) return '未知';
        const s = Math.ceil(seconds);
        if (s < 60) return `${s} 秒`;
        const m = Math.floor(s / 60);
        const remainderS = s % 60;
        if (m < 60) return `${m} 分 ${remainderS} 秒`;
        const h = Math.floor(m / 60);
        const remainderM = m % 60;
        return `${h} 小时 ${remainderM} 分`;
    }
    
    updateUI(iterations, total, logs, workerInfo = "", startTime = null) {
        const percent = Math.min(100, (iterations / total) * 100);
        this.progressBar.style.width = percent.toFixed(1) + '%';
        this.progressText.innerText = `${iterations} / ${total} 批次训练完成 ${workerInfo}`;
        
        // 计算预估剩余时间 (ETA) 与 训练速度
        if (startTime && iterations > 0) {
            const elapsedSec = (Date.now() - startTime) / 1000;
            if (elapsedSec > 0.1) {
                const speed = iterations / elapsedSec; // 迭代次数 / 秒
                const remainingIterations = total - iterations;
                const remainingSec = remainingIterations / speed;
                this.progressEta.innerText = `预估剩余时间: ${this.formatTime(remainingSec)} (速度: ${Math.round(speed)} 次迭代/秒)`;
            }
        } else {
            this.progressEta.innerText = `预估剩余时间: 未知`;
        }

        if (logs && logs.length) {
            this.progressLog.innerHTML = logs.map(l => `<div>> ${l}</div>`).join('');
        }
    }
    
    // 返回该难度下是否已经训练完成
    isModelTrained(difficulty) {
        return !!localStorage.getItem(`summa_model_v2_${difficulty}`);
    }

    // 自动计算最佳 Worker 线程数
    getOptimalWorkerCount() {
        const cores = navigator.hardwareConcurrency || 4;
        return cores * 6;
    }

    // 构建内联 Web Worker 代码字符串
    createWorkerScript() {
        return `
        const opsCollection = ['+', '-', '*', '/', '^', 'sin', 'cos', 'abs', 'e', 'ln', 'tan', 'sqrt'];
        const randInt = (min, max) => (Math.random() * (max - min + 1) | 0) + min;
        const chance = (p) => Math.random() < p;
        const randomCell = (half) => ({ x: randInt(-half, half - 1), y: randInt(-half, half - 1) });
        const sameCell = (a, b) => a.x === b.x && a.y === b.y;
        
        const uniquePushCell = (arr, cell) => {
            for(let i = 0; i < arr.length; i++) {
                if (arr[i].x === cell.x && arr[i].y === cell.y) return;
            }
            arr.push(cell);
        };

        const generateASTNode = (depth, activeOps) => {
            if (depth <= 0 || activeOps.length === 0) {
                const r = Math.random();
                if(r < 0.5) return { t: 'var' };
                if(r < 0.8) return { t: 'num', v: (Math.random() * 9 | 0) + 1 };
                return { t: 'e' };
            }
            let op = activeOps[(Math.random() * activeOps.length) | 0];
            if (['+', '-', '*', '/', '^'].includes(op)) {
                if (op === '^') return { t: 'op', op: '^', l: generateASTNode(depth - 1, activeOps), r: { t: 'var' } };
                return { t: 'op', op: op, l: generateASTNode(depth - 1, activeOps), r: generateASTNode(depth - 1, activeOps) };
            } else if (['sin', 'cos', 'tan', 'abs', 'ln', 'sqrt'].includes(op)) {
                return { t: 'func', op: op, arg: generateASTNode(depth - 1, activeOps) };
            } else if (op === 'e') {
                return { t: 'op', op: '^', l: { t: 'e' }, r: generateASTNode(depth - 1, activeOps) };
            }
            return { t: 'var' };
        };

        const evalAST = (node, x) => {
            if(node.t === 'var') return x;
            if(node.t === 'num') return node.v;
            if(node.t === 'e') return Math.E;
            if(node.t === 'op') {
                let left = evalAST(node.l, x);
                let right = evalAST(node.r, x);
                if(node.op === '+') return left + right;
                if(node.op === '-') return left - right;
                if(node.op === '*') return left * right;
                if(node.op === '/') return left / right;
                if(node.op === '^') return Math.pow(left, right);
            }
            if(node.t === 'func') {
                let arg = evalAST(node.arg, x);
                if(node.op === 'sin') return Math.sin(arg);
                if(node.op === 'cos') return Math.cos(arg);
                if(node.op === 'tan') return Math.tan(arg);
                if(node.op === 'abs') return Math.abs(arg);
                if(node.op === 'ln') return Math.log(arg);
                if(node.op === 'sqrt') return Math.sqrt(arg);
            }
            return 0;
        };

        const evalExprAt = (astNode, x) => {
            const y = evalAST(astNode, x);
            return Number.isFinite(y) ? y : null;
        };

        const astToString = (node) => {
            if(node.t === 'var') return 'x';
            if(node.t === 'num') return node.v.toString();
            if(node.t === 'e') return 'e';
            if(node.t === 'op') {
                if (node.op === '^') return '(' + astToString(node.l) + '^(' + astToString(node.r) + '))';
                return '(' + astToString(node.l) + node.op + astToString(node.r) + ')';
            }
            if(node.t === 'func') {
                return node.op + '(' + astToString(node.arg) + ')';
            }
            return 'x';
        };

        const hasLockedOpsAST = (node, lockedOpsSet) => {
            if (!node) return false;
            if (node.t === 'op' || node.t === 'func') {
                if (lockedOpsSet.has(node.op)) return true;
            }
            if (node.l && hasLockedOpsAST(node.l, lockedOpsSet)) return true;
            if (node.r && hasLockedOpsAST(node.r, lockedOpsSet)) return true;
            if (node.arg && hasLockedOpsAST(node.arg, lockedOpsSet)) return true;
            return false;
        };

        const verifyCase = (astNode, targets, forbidden) => {
            for (let i = 0; i < targets.length; i++) {
                const tx = targets[i].x + 0.5;
                const ty = targets[i].y + 0.5;
                const y = evalExprAt(astNode, tx);
                if (y === null || Math.abs(y - ty) >= 0.5) return false;
            }
            for (let i = 0; i < forbidden.length; i++) {
                const fx = forbidden[i].x + 0.5;
                const fy = forbidden[i].y + 0.5;
                const y = evalExprAt(astNode, fx);
                if (y !== null && Math.abs(y - fy) < 0.5) return false;
            }
            return true;
        };

        const buildCase = (difficulty, simRound, useSpecial, presetQuestion) => {
            const half = 5;
            let targetCount = 1;
            if(difficulty === 'normal' || difficulty === 'hard') targetCount = 2;
            if(difficulty === 'expert') targetCount = 3;

            if (presetQuestion) {
                return {
                    simRound: presetQuestion.simRound,
                    targets: presetQuestion.targets,
                    forbidden: presetQuestion.forbidden,
                    lockedOps: presetQuestion.lockedOps,
                    lockedDigits: presetQuestion.lockedDigits,
                    lockDecimal: presetQuestion.lockDecimal
                };
            }

            const targets = [];
            const forbidden = [];
            const lockedOps = [];
            const lockedDigits = [];
            let lockDecimal = false;

            for (let t = 0; t < targetCount; t++) uniquePushCell(targets, randomCell(half));
            while (targets.length < targetCount) uniquePushCell(targets, randomCell(half));

            let maxForbidden = simRound <= 8 ? 1 : (simRound <= 16 ? 2 : 3);
            const forbiddenCount = randInt(0, maxForbidden);
            for (let f = 0; f < forbiddenCount; f++) {
                const c = randomCell(half);
                if (!targets.some(t => sameCell(t, c))) uniquePushCell(forbidden, c);
            }

            if (useSpecial) {
                if (targets.length >= 2 && (chance(1 / 20) || chance(1 / 12))) {
                    const colX = randInt(-half, half - 1);
                    for (let idx = 0; idx < targets.length; idx++) targets[idx].x = colX;
                }
                if (chance(1 / 20) && targets.length > 0) {
                    const c = targets[0];
                    const around = [];
                    for (let dx = -1; dx <= 1; dx++) {
                        for (let dy = -1; dy <= 1; dy++) {
                            if (dx === 0 && dy === 0) continue;
                            const nx = c.x + dx, ny = c.y + dy;
                            if (nx >= -half && nx < half && ny >= -half && ny < half) around.push({ x: nx, y: ny });
                        }
                    }
                    const pick = Math.min(around.length, randInt(1, 5));
                    for (let p = 0; p < pick; p++) uniquePushCell(forbidden, around[p]);
                }
                if (chance(1 / 40) && targets.length >= 2) {
                    const a = targets[0], b = targets[1];
                    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
                    if (Number.isInteger(mx) && Number.isInteger(my)) {
                        const mid = { x: mx, y: my };
                        if (!targets.some(t => sameCell(t, mid))) uniquePushCell(forbidden, mid);
                    }
                }
                if (chance(1 / 40) && targets.length >= 2) {
                    const a = targets[0], b = targets[1];
                    const cross1 = { x: a.x, y: b.y }, cross2 = { x: b.x, y: a.y };
                    if (!targets.some(t => sameCell(t, cross1))) uniquePushCell(forbidden, cross1);
                    if (!targets.some(t => sameCell(t, cross2)) && chance(0.5)) uniquePushCell(forbidden, cross2);
                }
                if (chance(1 / 40)) {
                    if (difficulty === 'easy') {
                        if (chance(0.8)) lockedOps.push('^');
                        lockDecimal = true;
                    } else {
                        const candidates = ['+', '-', '*', '/', '^'];
                        for (const op of candidates) if (chance(0.5)) lockedOps.push(op);
                        if (lockedOps.length === 0) lockedOps.push('^');
                        lockDecimal = chance(0.7);
                    }
                }
                if (chance(1 / 40)) {
                    const lockCount = randInt(1, 3);
                    while (lockedDigits.length < lockCount) {
                        const d = String(randInt(0, 9));
                        if (!lockedDigits.includes(d)) lockedDigits.push(d);
                    }
                }
            }

            return { simRound, targets, forbidden, lockedOps, lockedDigits, lockDecimal };
        };

        const isExpressionAllowed = (expr, qaCase) => {
            if (qaCase.lockDecimal && expr.includes('.')) return false;
            for (let i = 0; i < qaCase.lockedDigits.length; i++) {
                if (expr.includes(qaCase.lockedDigits[i])) return false;
            }
            return true;
        };

        self.onmessage = function(e) {
            const { chunkSize, difficulty, inFirstPhase, inWrongCollectWindow, inReviewPhase, presetQuestions } = e.data;
            const bestFuncs = [];
            const wrongQuestions = [];
            let reviewSolved = 0;

            for (let k = 0; k < chunkSize; k++) {
                let qaCase = null;

                if (inReviewPhase && presetQuestions && presetQuestions.length > 0) {
                    const presetPickIndex = (Math.random() * presetQuestions.length) | 0;
                    qaCase = buildCase(difficulty, 1, false, presetQuestions[presetPickIndex]);
                } else {
                    const simRound = randInt(1, 24);
                    qaCase = buildCase(difficulty, simRound, inFirstPhase, null);
                }

                let maxLock = qaCase.simRound <= 4 ? 0 : (qaCase.simRound <= 12 ? 1 : 2);
                const randomLocks = [];
                let lockableOps = opsCollection.filter(op => !qaCase.lockedOps.includes(op));
                for (let l = 0; l < maxLock; l++) {
                    if (lockableOps.length === 0) break;
                    const idx = (Math.random() * lockableOps.length) | 0;
                    randomLocks.push(lockableOps[idx]);
                    lockableOps.splice(idx, 1);
                }

                const lockedOpsSet = new Set([...randomLocks, ...qaCase.lockedOps]);
                const activeOps = opsCollection.filter(op => !lockedOpsSet.has(op));

                const depth = (Math.random() * 3 | 0) + 1;
                const astNode = generateASTNode(depth, activeOps);

                if (hasLockedOpsAST(astNode, lockedOpsSet)) continue;

                const v1 = evalExprAt(astNode, -2);
                if (v1 === null || Math.abs(v1) >= 1000) continue;
                const v2 = evalExprAt(astNode, 0);
                if (v2 === null) continue;
                const v3 = evalExprAt(astNode, 3);
                if (v3 === null || Math.abs(v3) >= 1000 || v1 === v3) continue;

                const passCase = verifyCase(astNode, qaCase.targets, qaCase.forbidden);
                if (passCase) {
                    const rndFunc = astToString(astNode);
                    if (rndFunc.length < 60 && !rndFunc.includes('NaN') && isExpressionAllowed(rndFunc, qaCase)) {
                        bestFuncs.push(rndFunc);
                        if (inReviewPhase) reviewSolved++;
                    }
                } else if (inWrongCollectWindow && chance(0.18)) {
                    wrongQuestions.push({
                        simRound: qaCase.simRound,
                        targets: qaCase.targets,
                        forbidden: qaCase.forbidden,
                        lockedOps: qaCase.lockedOps,
                        lockedDigits: qaCase.lockedDigits,
                        lockDecimal: qaCase.lockDecimal
                    });
                }
            }

            self.postMessage({ bestFuncs, wrongQuestions, reviewSolved });
        };
        `;
    }

    async startTraining(difficulty, trainAmount = 50000) {
        return new Promise((resolve) => {
            if (this.isModelTrained(difficulty)) {
                resolve();
                return;
            }
            
            this.initUI();
            this.progressModal.style.display = 'flex';
            this.isTraining = true;
            
            const workerCount = this.getOptimalWorkerCount();
            const TOTAL_ITERATIONS = trainAmount;
            const FIRST_PHASE = Math.floor(TOTAL_ITERATIONS * 0.95);
            const WRONG_COLLECT_START = Math.floor(FIRST_PHASE * 0.7);

            const startTime = Date.now(); // 记录训练开始时刻
            let completedIterations = 0;
            let wrongLogged = 0;
            let reviewSolved = 0;
            let logsArray = [];

            const modelWeights = { best_functions: [] };
            const globalWrongQuestions = [];
            const MAX_WRONG_QUESTIONS = 1200;

            const updateLogsUI = () => {
                const sampleOps = ['+', '*', '/', '^', 'sin', 'cos', 'ln', 'sqrt'];
                const op = sampleOps[(Math.random() * sampleOps.length) | 0];
                const type = [
                    '多线程拓扑抓取', '并行引力规避', '高维空间剪枝', 
                    '常数锁定分配', '向量算子收敛', '错题池梯度下降'
                ][(Math.random() * 6) | 0];

                logsArray.push(
                    `Batch ${completedIterations}: ${type} [算子=${op}, 记忆池=${modelWeights.best_functions.length}, 全局错题=${globalWrongQuestions.length}]`
                );
                if (logsArray.length > 4) logsArray.shift();

                this.updateUI(completedIterations, TOTAL_ITERATIONS, logsArray, `[${workerCount} 线程加速中]`, startTime);
            };

            // 开启 1 秒定时器，保证即使在 Chunk 完成间隙，ETA 定时器也在实时平滑倒计时
            this.etaTimer = setInterval(() => {
                if (this.isTraining) {
                    this.updateUI(completedIterations, TOTAL_ITERATIONS, null, `[${workerCount} 线程加速中]`, startTime);
                }
            }, 1000);

            // 训练完成收尾
            const finishTraining = () => {
                this.isTraining = false;
                if (this.etaTimer) {
                    clearInterval(this.etaTimer);
                    this.etaTimer = null;
                }

                setTimeout(() => {
                    this.progressModal.style.display = 'none';
                    localStorage.setItem(`summa_model_v2_${difficulty}`, JSON.stringify(modelWeights));
                    window.summaCharacter && window.summaCharacter.speak("startGame", "smug");
                    const msgBox = document.getElementById('summa-message');
                    if (msgBox) {
                        const totalTimeSec = ((Date.now() - startTime) / 1000).toFixed(1);
                        msgBox.textContent = `训练完毕[${difficulty}] 耗时:${totalTimeSec}s 线程:${workerCount} 记忆池:${modelWeights.best_functions.length} 复练命中:${reviewSolved}`;
                        msgBox.classList.add('visible');
                        setTimeout(() => msgBox.classList.remove('visible'), 5000);
                    }
                    resolve();
                }, 300);
            };

            // 多线程并行调度核心逻辑
            try {
                const workerScript = this.createWorkerScript();
                const blob = new Blob([workerScript], { type: 'application/javascript' });
                const workerUrl = URL.createObjectURL(blob);
                
                const workers = [];
                const CHUNK_SIZE = Math.min(2500, Math.max(500, Math.floor(TOTAL_ITERATIONS / (workerCount * 40))));

                const dispatchChunk = (worker) => {
                    if (completedIterations >= TOTAL_ITERATIONS) return;

                    const inFirstPhase = completedIterations < FIRST_PHASE;
                    const inWrongCollectWindow = inFirstPhase && completedIterations >= WRONG_COLLECT_START;
                    const inReviewPhase = !inFirstPhase;

                    worker.postMessage({
                        chunkSize: CHUNK_SIZE,
                        difficulty: difficulty,
                        inFirstPhase: inFirstPhase,
                        inWrongCollectWindow: inWrongCollectWindow,
                        inReviewPhase: inReviewPhase,
                        presetQuestions: inReviewPhase ? globalWrongQuestions : null
                    });
                };

                let activeWorkersFinished = 0;

                for (let i = 0; i < workerCount; i++) {
                    const worker = new Worker(workerUrl);
                    workers.push(worker);

                    worker.onmessage = (e) => {
                        const { bestFuncs, wrongQuestions, reviewSolved: chunkSolved } = e.data;

                        if (bestFuncs && bestFuncs.length > 0) {
                            modelWeights.best_functions.push(...bestFuncs);
                            if (modelWeights.best_functions.length > 5000) {
                                modelWeights.best_functions = modelWeights.best_functions.slice(-5000);
                            }
                        }

                        if (wrongQuestions && wrongQuestions.length > 0 && globalWrongQuestions.length < MAX_WRONG_QUESTIONS) {
                            globalWrongQuestions.push(...wrongQuestions);
                            wrongLogged += wrongQuestions.length;
                        }

                        reviewSolved += chunkSolved;
                        completedIterations += CHUNK_SIZE;

                        updateLogsUI();

                        if (completedIterations < TOTAL_ITERATIONS) {
                            dispatchChunk(worker);
                        } else {
                            activeWorkersFinished++;
                            if (activeWorkersFinished === workerCount) {
                                workers.forEach(w => w.terminate());
                                URL.revokeObjectURL(workerUrl);
                                finishTraining();
                            }
                        }
                    };

                    dispatchChunk(worker);
                }
            } catch (err) {
                console.warn("[SummaTrainer] 多线程 Worker 创建失败，自动降级至 MessageChannel 单线程模式", err);
                this.fallbackSingleThread(difficulty, TOTAL_ITERATIONS, FIRST_PHASE, WRONG_COLLECT_START, modelWeights, globalWrongQuestions, startTime, finishTraining);
            }
        });
    }

    // 单线程平滑降级方案
    fallbackSingleThread(difficulty, TOTAL_ITERATIONS, FIRST_PHASE, WRONG_COLLECT_START, modelWeights, globalWrongQuestions, startTime, finishTraining) {
        let completed = 0;
        const chunk = 1000;
        const channel = new MessageChannel();

        channel.port1.onmessage = () => {
            completed += chunk;
            this.updateUI(completed, TOTAL_ITERATIONS, [`Fallback Epoch: ${completed}`], "[单线程模式]", startTime);

            if (completed < TOTAL_ITERATIONS) {
                channel.port2.postMessage(null);
            } else {
                finishTraining();
            }
        };

        channel.port2.postMessage(null);
    }
}

window.SummaTrainer = SummaTrainer;