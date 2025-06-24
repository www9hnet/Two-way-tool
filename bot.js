require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const db = require('./db');

// --- 初始化 ---
if (!process.env.BOT_TOKEN) {
    console.error('错误：请在 .env 文件中设置您的 BOT_TOKEN (ERROR: Please set your BOT_TOKEN in the .env file)');
    process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);
db.load();
const data = db.get();
// 兼容旧数据
if (!data.blacklist) data.blacklist = {};
if (!data.settings) data.settings = { autoEndButton: true };


// --- 辅助函数 ---

const isInitialized = () => data.admins.length > 0;
const isAdmin = (userId) => isInitialized() && data.admins.includes(userId);
const isService = (userId) => isInitialized() && !!data.service[userId];
const isBlocked = (userId) => isInitialized() && !!data.blacklist[userId];

/**
 * @description 从被回复的消息中解析出原始用户ID和用户名
 * @param {object} repliedMessage - Telegraf的 message.reply_to_message 对象
 * @returns {{userId: string|null, username: string|null}}
 */
const parseUserIdFromReply = (repliedMessage) => {
    if (!repliedMessage) {
        return { userId: null, username: null };
    }
    const textToParse = repliedMessage.text || repliedMessage.caption || '';
    const match = textToParse.match(/@(\S+?)\((\d+)\)/);
    if (match && match[2]) {
        return { userId: match[2], username: match[1] };
    }
    return { userId: null, username: null };
};

/**
 * @description 将用户消息以智能、健壮的方式转发给客服
 * @param {object} ctx - Telegraf 上下文
 * @param {string|number} serviceId - 客服ID
 * @param {object} user - 用户信息对象
 * @param {boolean} isObserver - 是否是作为观察者接收
 */
const forwardUserMessageToService = (ctx, serviceId, user, isObserver = false) => {
    const service = data.service[serviceId];
    if (!service) return;

    const username = user.username || '用户';
    
    // 观察者和主客服看到的信息不同
    const baseText = isObserver 
        ? `\n\n👁️‍🗨️ [历史会话更新] 来自用户 @${username}(${user.id}) 的消息。`
        : `\n\n⬆️ 来自用户 @${username}(${user.id}) 的消息。`;

    // 1. 结束会话按钮
    const keyboardActions = [ Markup.button.url(`联系 ${username}`, `tg://user?id=${user.id}`) ];
    if (!isObserver && data.settings?.autoEndButton) {
        keyboardActions.push(Markup.button.callback('结束会话', `end_chat:${user.id}`));
    }
    const keyboard = Markup.inlineKeyboard(keyboardActions);
    
    const hasCaptionSupport = ctx.message.photo || ctx.message.video || ctx.message.document || ctx.message.animation || ctx.message.audio;

    if (ctx.message.text) {
        const newContent = ctx.message.text + baseText;
        bot.telegram.sendMessage(service.chatId, newContent, {
            reply_markup: keyboard.reply_markup
        }).catch(e => console.error(`[Forwarding] 发送文本消息至客服 ${serviceId} 失败:`, e));
    } else if (hasCaptionSupport) {
        const originalCaption = ctx.message.caption || '';
        const newCaption = originalCaption + baseText;
        bot.telegram.copyMessage(service.chatId, ctx.chat.id, ctx.message.message_id, {
            caption: newCaption,
            reply_markup: keyboard.reply_markup
        }).catch(e => console.error(`[Forwarding] 复制媒体消息至客服 ${serviceId} 失败:`, e));
    } else {
        ctx.forwardMessage(service.chatId).catch(e => console.error(`[Forwarding] 转发原始(无caption)消息失败:`, e));
        bot.telegram.sendMessage(service.chatId, baseText, {
            reply_markup: keyboard.reply_markup
        }).catch(e => console.error(`[Forwarding] 发送独立信息至客服 ${serviceId} 失败:`, e));
    }
};


const assignNextUser = (serviceId = null) => {
    if (!isInitialized() || data.waitingQueue.length === 0) {
        return;
    }

    if (serviceId && data.service[serviceId] && data.service[serviceId].serving === null) {
        const userId = data.waitingQueue.shift();
        const user = data.userChats[userId];
        const service = data.service[serviceId];
        
        if (user && service) {
            user.status = 'active';
            user.handler = serviceId;
            service.serving = userId;
            if (!user.history.includes(serviceId)) user.history.push(serviceId);
            db.save();
            console.log(`将等待用户 ${user.username} 分配给刚空闲的客服 ${service.username}`);
            bot.telegram.sendMessage(user.chatId, '已为您接通客服。').catch(e => console.error(e));
            bot.telegram.sendMessage(service.chatId, `已为您接入新用户 @${user.username}。\n您现在是TA的主要接待客服。`, {
                reply_markup: Markup.inlineKeyboard([
                    Markup.button.callback('结束会话', `end_chat:${userId}`)
                ]).reply_markup
            }).catch(e => console.error(e));
        }
    } else {
        const idleServices = Object.keys(data.service).filter(id => data.service[id].serving === null);
        if (idleServices.length > 0) {
            const randomServiceId = idleServices[Math.floor(Math.random() * idleServices.length)];
            assignNextUser(randomServiceId);
        }
    }
};

// --- 指令处理 ---

bot.start((ctx) => {
    let welcomeMessage = `您好, ${ctx.from.first_name}!\n欢迎使用TG双向助手机器人。`;
    if (!isInitialized()) {
        welcomeMessage += '\n\n**注意：机器人尚未初始化，请管理员使用 `/init <BOT_TOKEN>` 指令进行设置。**';
    } else {
        welcomeMessage += '\n\n- 普通用户可以直接发送消息进行咨询。\n- 输入 /bindService申请成为客服。\n- 客服或用户可使用 /rebind 更新会话ID。';
    }
    ctx.replyWithMarkdown(welcomeMessage);
});

bot.command('init', (ctx) => {
    if (isInitialized()) return ctx.reply('机器人已经初始化，无需重复操作。');
    
    const parts = ctx.message.text.split(' ');
    if (parts.length < 2) return ctx.reply('格式错误！\n请使用: `/init <YOUR_BOT_TOKEN>`', { parse_mode: 'Markdown' });
    
    const token = parts[1];
    if (token === process.env.BOT_TOKEN) {
        const user = ctx.from;
        data.admins.push(user.id);
        data.service[user.id] = {
            username: user.username || `${user.first_name} ${user.last_name || ''}`,
            chatId: ctx.chat.id,
            serving: null,
        };
        db.save();
        console.log(`✅ 机器人初始化成功！管理员: @${user.username} (${user.id})`);
        ctx.reply('🎉 机器人初始化成功！您现在是管理员，并且已自动成为客服。');
    } else {
        ctx.reply('❌ Token 错误，初始化失败。');
    }
});

bot.command('rebind', (ctx) => {
    const userId = ctx.from.id;
    const chatId = ctx.chat.id;
    let updated = false;
    if (isService(userId)) {
        data.service[userId].chatId = chatId;
        updated = true;
    }
    if (data.userChats[userId]) {
        data.userChats[userId].chatId = chatId;
        updated = true;
    }
    if (updated) {
        db.save();
        ctx.reply('✅ 您的会话ID已成功更新。');
    } else {
        ctx.reply('❌ 您没有需要更新的记录。');
    }
});

bot.command('bindService', (ctx) => {
    if (!isInitialized()) return ctx.reply('机器人尚未初始化，此功能暂不可用。');
    const user = ctx.from;
    if (isService(user.id)) return ctx.reply('您已经是客服了。');
    if (data.pendingRequests[user.id]) return ctx.reply('您的申请正在审批中，请勿重复提交。');

    data.pendingRequests[user.id] = {
        username: user.username || `${user.first_name} ${user.last_name || ''}`,
        chatId: ctx.chat.id,
    };
    db.save();
    ctx.reply('您的客服申请已提交，请等待管理员审批。');

    const approvalMessage = `收到新的客服申请:\n用户: @${data.pendingRequests[user.id].username} (ID: ${user.id})\n请审批:`;
    const approvalKeyboard = Markup.inlineKeyboard([
        Markup.button.callback('✅ 同意', `approve:${user.id}`),
        Markup.button.callback('❌ 拒绝', `reject:${user.id}`),
    ]);
    data.admins.forEach(adminId => {
        const admin = data.service[adminId];
        if (admin) {
            bot.telegram.sendMessage(admin.chatId, approvalMessage, approvalKeyboard).catch(e => console.error(e));
        }
    });
});

// --- 客服与管理员指令 ---

bot.command('list', (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    let listText = '当前客服状态列表:\n\n';
    if (Object.keys(data.service).length === 0) {
        listText = '当前没有客服。';
    } else {
        for (const id in data.service) {
            const s = data.service[id];
            let status = '🟢 空闲';
            if (s.serving) {
                const servingUser = data.userChats[s.serving];
                status = `🔴 接待中: @${servingUser ? servingUser.username : '未知用户'}`;
            }
            listText += `客服: @${s.username}\n状态: ${status}\n\n`;
        }
    }
    ctx.reply(listText);
});

bot.command('unbindService', (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const parts = ctx.message.text.split(' ');
    if (parts.length < 2 || !parts[1].startsWith('@')) return ctx.reply('格式错误。正确用法: /unbindService @客服用户名');
    
    const targetUsername = parts[1].substring(1);
    const targetId = Object.keys(data.service).find(id => data.service[id].username === targetUsername);

    if (!targetId) return ctx.reply(`未找到客服 @${targetUsername}。`);
    if (targetId == ctx.from.id) return ctx.reply('不能解雇自己。');
    if (isAdmin(parseInt(targetId, 10))) return ctx.reply('不能解雇管理员。');

    const unboundService = data.service[targetId];
    bot.telegram.sendMessage(unboundService.chatId, '您已被管理员解除客服身份。').catch(e => console.error(e));
    delete data.service[targetId];
    ctx.reply(`客服 @${targetUsername} 已被解雇。`);

    if (unboundService.serving) {
        const user = data.userChats[unboundService.serving];
        if (user) {
            user.status = 'waiting';
            user.handler = null;
            data.waitingQueue.unshift(unboundService.serving);
            bot.telegram.sendMessage(user.chatId, '抱歉，接待您的客服已离开，已将您重新放入等待队列。').catch(e => console.error(e));
        }
    }
    db.save();
    assignNextUser();
});

const closeChatSession = (ctx, serviceId, userIdToClose) => {
    const service = data.service[serviceId];
    const user = data.userChats[userIdToClose];

    if (!user || !service) return;

    if (service.serving && service.serving == userIdToClose) {
        ctx.reply(`✅ 您已成功结束与用户 @${user.username} 的对话。`);
        bot.telegram.sendMessage(user.chatId, `客服已结束本次会话。`).catch(e=>console.error(e));
        
        user.handler = null; 
        service.serving = null;
        db.save();
        
        assignNextUser(serviceId);
    } else {
        let currentStatus = "您当前处于空闲状态。";
        if (service.serving) {
             const currentUser = data.userChats[service.serving];
             currentStatus = `您正在接待另一位用户 (@${currentUser.username})。`;
        }
        ctx.reply(`⚠️ 操作失败。您试图关闭与 @${user.username} 的对话，但 ${currentStatus}`);
    }
}

bot.command('close', (ctx) => {
    if (!isService(ctx.from.id)) return;
    
    const serviceId = ctx.from.id;
    const { userId: repliedUserId } = parseUserIdFromReply(ctx.message.reply_to_message);

    if (repliedUserId) {
        closeChatSession(ctx, serviceId, repliedUserId);
    } else {
        const currentlyServing = data.service[serviceId].serving;
        if (currentlyServing) {
            closeChatSession(ctx, serviceId, currentlyServing);
        } else {
            ctx.reply('❌ 您当前没有服务任何用户，也未回复特定用户消息。无法关闭会话。');
        }
    }
});


bot.command('block', (ctx) => {
    if (!isService(ctx.from.id)) return;

    const serviceId = ctx.from.id;
    const { userId: repliedUserId, username: repliedUsername } = parseUserIdFromReply(ctx.message.reply_to_message);
    
    let userIdToBlock = repliedUserId;
    let usernameToBlock = repliedUsername;

    // 如果不是回复，则检查当前服务的用户
    if (!userIdToBlock) {
        const currentlyServingId = data.service[serviceId].serving;
        if (currentlyServingId) {
            userIdToBlock = currentlyServingId;
            const user = data.userChats[userIdToBlock];
            usernameToBlock = user ? user.username : '未知用户';
        } else {
            return ctx.reply('❌ 操作无效。请回复您想拉黑的用户消息，或确保您正在接待一个用户。');
        }
    }
    
    if (isBlocked(userIdToBlock)) return ctx.reply(`用户 @${usernameToBlock} 已在黑名单中。`);
    if (isAdmin(userIdToBlock) || isService(userIdToBlock)) return ctx.reply('❌ 不能拉黑客服或管理员。');

    data.blacklist[userIdToBlock] = {
        username: usernameToBlock,
        blockedAt: new Date().toISOString()
    };
    
    ctx.reply(`✅ 用户 @${usernameToBlock}(${userIdToBlock}) 已被成功拉黑。`);

    // 如果拉黑的是当前服务的用户，则自动关闭会话
    const service = data.service[serviceId];
    if (service.serving && service.serving == userIdToBlock) {
        const user = data.userChats[userIdToBlock];
        user.handler = null; 
        service.serving = null;
        console.log(`客服 @${service.username} 拉黑了正在服务的用户 @${user.username}，会话已自动关闭。`);
        assignNextUser(serviceId); // 尝试分配新用户
    }
    db.save();
});

bot.command('unblock', (ctx) => {
    if (!isService(ctx.from.id)) return;
    const parts = ctx.message.text.split(' ');
    if (parts.length < 2) return ctx.reply('格式错误。正确用法: /unblock <用户ID或@用户名>');

    const target = parts[1];
    let targetId = null;

    if (target.startsWith('@')) {
        const username = target.substring(1);
        targetId = Object.keys(data.blacklist).find(id => data.blacklist[id].username === username);
    } else {
        targetId = target;
    }

    if (targetId && data.blacklist[targetId]) {
        const username = data.blacklist[targetId].username;
        delete data.blacklist[targetId];
        db.save();
        ctx.reply(`✅ 用户 @${username}(${targetId}) 已从黑名单中移除。`);
    } else {
        ctx.reply(`❌ 在黑名单中未找到用户: ${target}`);
    }
});

bot.command('blacklist', (ctx) => {
    if (!isService(ctx.from.id)) return;
    const list = Object.keys(data.blacklist);
    if (list.length === 0) return ctx.reply('黑名单当前为空。');

    let message = '🚫 黑名单列表:\n\n';
    list.forEach(userId => {
        const item = data.blacklist[userId];
        const date = new Date(item.blockedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
        message += `用户: @${item.username} (ID: ${userId})\n拉黑时间: ${date}\n\n`;
    });
    ctx.reply(message);
});

// --- 回调处理 ---
bot.action(/end_chat:(\d+)/, (ctx) => {
    if (!isService(ctx.from.id)) return ctx.answerCbQuery('您不是客服。');
    
    const serviceId = ctx.from.id;
    const userIdToClose = ctx.match[1];
    
    closeChatSession(ctx, serviceId, userIdToClose);
    ctx.deleteMessage().catch(()=>{}); // Try to delete the message with the button
    return ctx.answerCbQuery('操作成功。');
});

bot.action(/^(approve|reject):(.+)$/, (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('您没有权限操作。');
    
    const action = ctx.match[1];
    const targetUserId = ctx.match[2];
    const request = data.pendingRequests[targetUserId];

    if (!request) return ctx.editMessageText('此申请已被处理。');

    if (action === 'approve') {
        const userInChat = data.userChats[targetUserId];
        if(userInChat) {
            if (userInChat.handler) {
                const handlingService = data.service[userInChat.handler];
                if(handlingService) {
                    handlingService.serving = null;
                    assignNextUser(userInChat.handler);
                }
            }
            const queueIndex = data.waitingQueue.indexOf(targetUserId);
            if (queueIndex > -1) data.waitingQueue.splice(queueIndex, 1);
            delete data.userChats[targetUserId];
        }
        data.service[targetUserId] = { username: request.username, chatId: request.chatId, serving: null };
        ctx.editMessageText(`申请已同意 (操作人: @${ctx.from.username})`);
        bot.telegram.sendMessage(request.chatId, '恭喜！您的客服申请已通过。').catch(e => console.error(e));
    } else {
        ctx.editMessageText(`申请已拒绝 (操作人: @${ctx.from.username})`);
        bot.telegram.sendMessage(request.chatId, '很遗憾，您的客服申请已被拒绝。').catch(e => console.error(e));
    }
    delete data.pendingRequests[targetUserId];
    db.save();
    ctx.answerCbQuery('操作成功。');
});

// --- 消息处理 ---
bot.on('message', (ctx) => {
    if (ctx.message.text && ctx.message.text.startsWith('/')) return;

    const userId = ctx.from.id;

    // --- 情况1: 消息来自客服 ---
    if (isService(userId)) {
        const service = data.service[userId];
        const { userId: repliedUserId, username: repliedUsername } = parseUserIdFromReply(ctx.message.reply_to_message);

        let targetUserId = repliedUserId;
        if (!targetUserId) {
            targetUserId = service.serving;
            if (!targetUserId) {
                return ctx.reply('💡您当前未接待任何用户，也未指定回复。请回复一条由机器人转发的用户消息来开始对话。');
            }
        }
        
        const userToReply = data.userChats[targetUserId];
        if (userToReply) {
            // 转发给用户
            ctx.copyMessage(userToReply.chatId).catch(e => {
                console.error(`回复用户 ${targetUserId} 失败:`, e);
                ctx.reply(`发送失败: ${e.message}`);
            });

            // 确保当前客服在历史记录中
            if (!userToReply.history.includes(String(userId))) {
                userToReply.history.push(String(userId));
            }

            // 通知其他历史客服
            userToReply.history.forEach(historicalId => {
                if (historicalId != userId && data.service[historicalId]) {
                    const observer = data.service[historicalId];
                    const msg = ctx.message.text || ctx.message.caption || '[媒体消息]';
                    const notice = `[会话更新] 客服 @${service.username} 回复了 @${userToReply.username}:\n\n${msg}`;
                    bot.telegram.sendMessage(observer.chatId, notice).catch(e => console.error(e));
                }
            });

        } else {
            ctx.reply('❌ 无法找到原始用户，可能对话已结束或用户数据已清除。');
        }
        db.save();
        return;
    }
    
    // --- 情况2: 消息来自普通用户 ---
    if (isBlocked(userId)) {
        console.log(`已忽略来自黑名单用户 ${userId} 的消息。`);
        return;
    }

    if (!isInitialized()) return ctx.reply('抱歉，客服系统正在维护中。');

    const chatId = ctx.chat.id;
    const username = ctx.from.username || `${ctx.from.first_name} ${ctx.from.last_name || ''}`;

    let currentUserChat = data.userChats[userId];
    if (!currentUserChat) {
        data.userChats[userId] = { id: userId, chatId, username, status: 'new', handler: null, history: [] };
        currentUserChat = data.userChats[userId];
    } else {
        currentUserChat.chatId = chatId;
        currentUserChat.username = username;
    }
    
    const distributeMessage = (ctx, userChat) => {
        // 2. 消息推送给所有历史客服
        userChat.history.forEach(serviceId => {
            const isObserver = serviceId !== userChat.handler;
            forwardUserMessageToService(ctx, serviceId, userChat, isObserver);
        });
    };

    if (currentUserChat.handler && data.service[currentUserChat.handler]) {
        console.log(`用户 ${username}(${userId}) 正在与客服 ${currentUserChat.handler} 的会话中，分发消息。`);
        distributeMessage(ctx, currentUserChat);
    } else {
        if (currentUserChat.handler) {
            console.log(`用户 ${userId} 的 handler ${currentUserChat.handler} 无效，重置 handler。`);
            currentUserChat.handler = null;
        }
        
        const idleServices = Object.keys(data.service).filter(id => data.service[id].serving === null);
        if (idleServices.length > 0) {
            const randomServiceId = idleServices[Math.floor(Math.random() * idleServices.length)];
            const service = data.service[randomServiceId];
            
            console.log(`为新会话用户 ${username}(${userId}) 分配客服: ${randomServiceId}`);

            currentUserChat.status = 'active';
            currentUserChat.handler = randomServiceId;
            service.serving = userId;
            
            if (!currentUserChat.history.includes(randomServiceId)) {
                currentUserChat.history.push(randomServiceId);
            }
            
            // 新分配的客服是主客服，其他历史客服是观察者
            distributeMessage(ctx, currentUserChat);

        } else {
            if (!data.waitingQueue.includes(userId)) {
                data.waitingQueue.push(userId);
                currentUserChat.status = 'waiting';
            }
            ctx.reply('当前客服全忙，您已进入等待队列，请耐心等候。');
            console.log(`用户 ${username}(${userId}) 进入等待队列`);
        }
    }

    db.save();
});

// --- 启动与停止 ---
process.once('SIGINT', () => { db.save(); bot.stop('SIGINT'); console.log('机器人停止'); });
process.once('SIGTERM', () => { db.save(); bot.stop('SIGTERM'); console.log('机器人停止'); });

bot.launch().then(() => {
    console.log('🚀 机器人已启动');
    if (!isInitialized()) {
        console.warn('⚠️ 警告: 机器人尚未初始化。请发送 `/init <你的BOT_TOKEN>`');
    } else {
        console.log('✅ 机器人已初始化。管理员:', data.admins);
    }
}).catch(err => {
    console.error('机器人启动失败:', err);
});
