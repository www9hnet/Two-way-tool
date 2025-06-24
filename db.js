const fs = require('fs');
const path = require('path');

// 数据存储文件的路径
const DB_PATH = path.join(__dirname, 'setting.json');

// 内存中的数据缓存
let dataStore = {};

// 默认数据结构 - admins 默认为空，表示未初始化
const getDefaultData = () => ({
    admins: [], // 管理员列表，初始化后添加
    service: {}, // 客服列表 { userId: { username, chatId, serving: null | userId } }
    pendingRequests: {}, // 待审批的客服申请 { userId: { username, chatId, requestMessageId } }
    userChats: {}, // 正在进行的对话 { userId: { chatId, username, status: 'active' | 'waiting', handler: serviceUserId, history: [serviceUserId] } }
    waitingQueue: [], // 等待队列 [userId]
});

/**
 * @description 从 setting.json 加载数据到内存。如果文件不存在，则创建并使用默认结构。
 */
function load() {
    try {
        if (fs.existsSync(DB_PATH)) {
            const rawData = fs.readFileSync(DB_PATH, 'utf8');
            dataStore = JSON.parse(rawData);
            // 兼容旧数据，如果 admins 不存在则添加
            if (!dataStore.admins) {
                dataStore.admins = [];
            }
            console.log('数据已成功加载 (Data loaded successfully).');
        } else {
            console.log('未找到 setting.json，将创建新文件 (setting.json not found, creating a new one).');
            dataStore = getDefaultData();
            save();
        }
    } catch (error) {
        console.error('加载数据失败，将使用默认数据 (Failed to load data, using default data):', error);
        dataStore = getDefaultData();
    }
}

/**
 * @description 将内存中的数据同步写入 setting.json 文件。
 */
function save() {
    try {
        fs.writeFileSync(DB_PATH, JSON.stringify(dataStore, null, 2), 'utf8');
    } catch (error) {
        console.error('保存数据失败 (Failed to save data):', error);
    }
}

/**
 * @description 获取对数据存储的引用。
 * @returns {object} 数据对象
 */
function get() {
    return dataStore;
}

module.exports = {
    load,
    save,
    get,
};
