/**
 * SeedCrypto - 关卡种子加密/解密模块（简化版）
 * 用于关卡编辑器
 */
class SeedCrypto {
    constructor() {
        this.MAP_SIZES = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
        this.ELEMENTS = ['x','+','-','*','/','(',')','0','1','2','3','4','5','6','7','8','9','π','e','i','ln','sin','cos','tan','sqrt','abs','^','!','.'];
    }

    /**
     * 加密关卡数据为种子
     */
    encrypt(levelData) {
        if (!levelData.targetCells || levelData.targetCells.length === 0) {
            throw new Error('关卡必须包含至少一个目标格');
        }

        const data = {
            targetCells: levelData.targetCells,
            forbiddenCells: levelData.forbiddenCells || [],
            lockedElements: levelData.lockedElements || [],
            solutionTokens: levelData.solutionTokens || 0,
            mapSize: levelData.mapSize || 20
        };

        // 将数据转换为JSON字符串，然后进行Base64编码
        const jsonStr = JSON.stringify(data);
        // 简单的编码：Base64 + 时间戳 + 随机盐
        const salt = Math.random().toString(36).substr(2, 6);
        const timestamp = Date.now().toString(36);
        const encoded = btoa(encodeURIComponent(jsonStr));
        const seed = `FC${timestamp}${salt}${encoded}`;
        return seed;
    }

    /**
     * 解密种子为关卡数据
     */
    decrypt(seed) {
        try {
            if (!seed || typeof seed !== 'string') {
                throw new Error('无效的种子');
            }

            // 检查种子格式
            if (!seed.startsWith('FC')) {
                // 尝试直接解析Base64
                const jsonStr = decodeURIComponent(atob(seed));
                return JSON.parse(jsonStr);
            }

            // 提取编码部分（去掉前缀、时间戳和盐）
            const encoded = seed.substr(6 + 10 + 6); // FC + timestamp + salt
            const jsonStr = decodeURIComponent(atob(encoded));
            const data = JSON.parse(jsonStr);

            // 验证数据完整性
            if (!data.targetCells || !Array.isArray(data.targetCells)) {
                throw new Error('种子格式不正确');
            }

            return data;
        } catch (e) {
            console.error('[SeedCrypto] 解密失败:', e);
            throw new Error('种子解密失败：' + e.message);
        }
    }
}

// 导出到全局
window.SeedCrypto = SeedCrypto;
