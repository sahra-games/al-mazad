require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const GROQ_KEY = process.env.GROQ_API_KEY;
const AUCTION_TIME = 15;
const BID_STEP = 100;
const START_BALANCE = 500;
const MAX_BID = 500;
const BATCH_SIZE = 5;
const REFILL_AT = 4;
const MAX_MEMORY = 60;

const CATEGORIES = {
  football: 'كرة القدم',
  general_info: 'معلومات عامة',
  islamic: 'إسلاميات',
  anime: 'الأنمي'
};

/* ═══════════════════════════════════════════════════════════════
   🤖 توليد الأسئلة (مع منع التكرار)
   ═══════════════════════════════════════════════════════════════ */
async function generateQuestions(catIds, previousQuestions = []) {
  if (!GROQ_KEY) throw new Error('GROQ_API_KEY missing');
  const catList = catIds.map(c => CATEGORIES[c] || c).join('، ');

  // آخر 30 سؤال بس عشان الطلب ميطولش
  const recent = previousQuestions.slice(-30);
  let avoidBlock = '';
  if (recent.length > 0) {
    avoidBlock = `\n⛔ ممنوع تماماً تكرار أو إعادة صياغة أي سؤال من الأسئلة دي (اتسألت قبل كده):\n${recent.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n`;
  }

  const prompt = `أعد 5 أسئلة معلومات عامة بالعربية من الفئات التالية فقط: ${catList}.
${avoidBlock}
شروط صارمة:
- سؤال مفتوح بإجابة واحدة قصيرة ومحددة (اسم، رقم، تاريخ، مكان)
- ممنوع تماماً أي اختيارات (أ-ب-ج-د) أو بدائل
- ممنوع "اختر الإجابة الصحيحة"
- الإجابة كلمة أو كلمتين أو رقم فقط
- كل النصوص بالعربية الفصحى
- نوّع في صعوبة الأسئلة (سهل، متوسط، صعب، صعب جدًا)
- كل سؤال من فئة مختلفة عن التاني لو أمكن
- لا تكرر أي سؤال من القائمة الممنوعة فوق، حتى لو بصيغة مختلفة

أعد JSON فقط:
{"questions":[{"category":"كرة القدم","question":"...","answer":"..."},{"category":"...","question":"...","answer":"..."},{"category":"...","question":"...","answer":"..."},{"category":"...","question":"...","answer":"..."},{"category":"...","question":"...","answer":"..."}]}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 1.0,
        max_tokens: 1800
      }),
      signal: controller.signal
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Groq HTTP ${res.status}: ${txt.slice(0, 120)}`);
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(content);
    const list = Array.isArray(parsed.questions) ? parsed.questions : [];

    return list.map(q => ({
      category: String(q.category || '').trim(),
      question: String(q.question || '').trim(),
      answer: String(q.answer || '').trim()
    })).filter(q => q.question.length > 3 && q.answer.length > 0);
  } finally {
    clearTimeout(timeout);
  }
}

/* ═══════════════════════════════════════════════════════════════
   🏠 الغرف
   ═══════════════════════════════════════════════════════════════ */
const rooms = new Map();

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function sanitize(str, max = 20) {
  return String(str || '').slice(0, max).replace(/[<>&"']/g, '');
}

function firstPlayerInTeam(room, teamIdx) {
  return Object.values(room.players).find(p => p.team === teamIdx) || null;
}

function publicRoom(room) {
  return {
    code: room.code,
    status: room.status,
    hostId: room.hostId,
    players: Object.values(room.players).map(p => ({
      id: p.id, name: p.name, team: p.team
    })),
    teams: room.teams,
    teamNames: room.teamNames || ['', ''],
    categories: room.categories,
    round: room.round,
    startingTeam: room.startingTeam,
    loading: room.loading,
    auction: room.auction ? {
      category: room.auction.category,
      currentBid: room.auction.currentBid,
      lastBidder: room.auction.lastBidder,
      activeTeam: room.auction.activeTeam,
      timeLeft: room.auction.timeLeft,
      winnerTeam: room.auction.winnerTeam,
      stealTeam: room.auction.stealTeam,
      stealPrice: room.auction.stealPrice,
      phase: room.auction.phase
    } : null,
    messages: room.messages.slice(-60)
  };
}

function broadcast(room) {
  io.to(room.code).emit('room-update', publicRoom(room));
}

function computeFinalTeamNames(room) {
  const total = Object.keys(room.players).length;
  const teams0 = Object.values(room.players).filter(p => p.team === 0);
  const teams1 = Object.values(room.players).filter(p => p.team === 1);

  if (total === 2) {
    room.teams[0].name = teams0[0]?.name || 'الفريق الأول';
    room.teams[1].name = teams1[0]?.name || 'الفريق الثاني';
  } else {
    room.teams[0].name = (room.teamNames[0] || teams0[0]?.name || 'الفريق الأول');
    room.teams[1].name = (room.teamNames[1] || teams1[0]?.name || 'الفريق الثاني');
  }
}

/* ═══════════════════════════════════════════════════════════════
   🎯 المزاد
   ═══════════════════════════════════════════════════════════════ */
function startAuctionTimer(room) {
  stopAuctionTimer(room);
  if (!room.auction) return;
  room.auction.timeLeft = AUCTION_TIME;

  room.auction.timer = setInterval(() => {
    if (!room.auction) { stopAuctionTimer(room); return; }
    room.auction.timeLeft--;

    if (room.auction.timeLeft <= 0) {
      stopAuctionTimer(room);
      handleTimeout(room);
    } else {
      broadcast(room);
    }
  }, 1000);
}

function stopAuctionTimer(room) {
  if (room.auction && room.auction.timer) {
    clearInterval(room.auction.timer);
    room.auction.timer = null;
  }
}

function handleTimeout(room) {
  const a = room.auction;
  if (!a) return;
  if (a.phase === 'bidding') handlePass(room, a.activeTeam);
}

function nextQuestionFromQueue(room) {
  if (room.questions.length === 0) return null;
  const q = room.questions.shift();
  if (room.questions.length <= BATCH_SIZE - REFILL_AT && !room.loading) {
    refillQuestions(room);
  }
  return q;
}

async function refillQuestions(room) {
  if (room.loading) return;
  room.loading = true;
  broadcast(room);
  try {
    const newQs = await generateQuestions(room.categories, room.askedQuestions);
    room.questions.push(...newQs);
    console.log(`✅ دفعة جديدة: ${newQs.length} أسئلة (المتبقي: ${room.questions.length})`);
  } catch (e) {
    console.error('❌ فشل تحميل الأسئلة:', e.message);
  } finally {
    room.loading = false;
    broadcast(room);
  }
}

function beginRound(room) {
  stopAuctionTimer(room);
  const q = nextQuestionFromQueue(room);
  if (!q) {
    refillQuestions(room);
    return;
  }

  // سجّل السؤال في الذاكرة عشان مايتكررش
  room.askedQuestions.push(q.question);
  if (room.askedQuestions.length > MAX_MEMORY) {
    room.askedQuestions = room.askedQuestions.slice(-MAX_MEMORY);
  }

  room.auction = {
    category: q.category,
    question: q.question,
    answer: q.answer,
    currentBid: 0,
    lastBidder: -1,
    activeTeam: room.startingTeam,
    winnerTeam: -1,
    stealTeam: -1,
    stealPrice: 0,
    phase: 'bidding',
    timeLeft: AUCTION_TIME,
    timer: null
  };

  broadcast(room);
  startAuctionTimer(room);
}

function handleBid(room, teamIdx) {
  const a = room.auction;
  if (!a || a.phase !== 'bidding') return;
  if (teamIdx !== a.activeTeam) return;

  const nextBid = a.currentBid + BID_STEP;

  if (nextBid > MAX_BID) return;
  if (nextBid > room.teams[teamIdx].balance) return;

  a.currentBid = nextBid;
  a.lastBidder = teamIdx;
  a.activeTeam = 1 - teamIdx;
  a.timeLeft = AUCTION_TIME;
  broadcast(room);
}

function handlePass(room, teamIdx) {
  const a = room.auction;
  if (!a || a.phase !== 'bidding') return;
  if (teamIdx !== a.activeTeam) return;

  stopAuctionTimer(room);

  if (a.lastBidder === -1) {
    const winner = 1 - teamIdx;
    if (room.teams[winner].balance < BID_STEP) {
      endAuction(room);
      return;
    }
    a.currentBid = BID_STEP;
    a.lastBidder = winner;
    a.winnerTeam = winner;
  } else {
    a.winnerTeam = a.lastBidder;
  }

  room.teams[a.winnerTeam].balance -= a.currentBid;
  a.phase = 'answering';

  io.to(room.code).emit('auction-won', {
    winnerTeam: a.winnerTeam,
    bid: a.currentBid,
    category: a.category
  });

  const winnerSockets = Object.values(room.players).filter(p => p.team === a.winnerTeam);
  winnerSockets.forEach(p => {
    io.to(p.id).emit('show-question', {
      question: a.question,
      answer: a.answer,
      isSteal: false
    });
  });

  broadcast(room);
}

function handleAnswer(room, teamIdx, isCorrect) {
  const a = room.auction;
  if (!a || a.phase !== 'answering') return;
  if (teamIdx !== a.winnerTeam) return;

  stopAuctionTimer(room);

  if (isCorrect) {
    const reward = a.currentBid * 2;
    room.teams[teamIdx].balance += reward;
    io.to(room.code).emit('answer-result', {
      team: teamIdx, correct: true, reward, isSteal: false
    });
    endAuction(room);
  } else {
    const halfBid = Math.floor(a.currentBid / 2);
    const otherTeam = 1 - teamIdx;

    if (room.teams[otherTeam].balance < halfBid || halfBid < BID_STEP) {
      io.to(room.code).emit('answer-result', {
        team: teamIdx, correct: false, reward: 0, isSteal: false
      });
      endAuction(room);
      return;
    }

    a.phase = 'steal-offer';
    a.stealPrice = halfBid;
    a.stealTeam = otherTeam;
    a.timeLeft = 15;
    broadcast(room);
    io.to(room.code).emit('steal-offer', { team: otherTeam, price: halfBid });
    startAuctionTimer(room);
  }
}

function handleStealDecision(room, accept) {
  const a = room.auction;
  if (!a || a.phase !== 'steal-offer') return;

  stopAuctionTimer(room);

  if (!accept) {
    io.to(room.code).emit('answer-result', {
      team: a.winnerTeam, correct: false, reward: 0, isSteal: false
    });
    endAuction(room);
    return;
  }

  room.teams[a.stealTeam].balance -= a.stealPrice;
  a.phase = 'steal-answering';

  const stealSockets = Object.values(room.players).filter(p => p.team === a.stealTeam);
  stealSockets.forEach(p => {
    io.to(p.id).emit('show-question', {
      question: a.question,
      answer: a.answer,
      isSteal: true
    });
  });

  broadcast(room);
}

function handleStealAnswer(room, isCorrect) {
  const a = room.auction;
  if (!a || a.phase !== 'steal-answering') return;

  stopAuctionTimer(room);

  if (isCorrect) {
    const reward = a.stealPrice * 2;
    room.teams[a.stealTeam].balance += reward;
    io.to(room.code).emit('answer-result', {
      team: a.stealTeam, correct: true, reward, isSteal: true
    });
  } else {
    io.to(room.code).emit('answer-result', {
      team: a.stealTeam, correct: false, reward: 0, isSteal: true
    });
  }
  endAuction(room);
}

function endAuction(room) {
  stopAuctionTimer(room);
  room.auction = null;

  const b0 = room.teams[0].balance;
  const b1 = room.teams[1].balance;

  if (b0 <= 0 || b1 <= 0) {
    room.status = 'ended';
    broadcast(room);
    return;
  }

  room.round++;
  room.startingTeam = 1 - room.startingTeam;

  broadcast(room);
  setTimeout(() => beginRound(room), 1500);
}

/* ═══════════════════════════════════════════════════════════════
   🔌 Socket handlers
   ═══════════════════════════════════════════════════════════════ */
io.on('connection', (socket) => {
  socket.on('create-room', ({ name }, cb) => {
    let code;
    do { code = generateCode(); } while (rooms.has(code));

    const room = {
      code,
      hostId: socket.id,
      status: 'lobby',
      players: {},
      teams: [
        { name: 'الفريق الأول', balance: START_BALANCE },
        { name: 'الفريق الثاني', balance: START_BALANCE }
      ],
      teamNames: ['', ''],
      categories: [],
      questions: [],
      askedQuestions: [],
      round: 1,
      startingTeam: 0,
      auction: null,
      messages: [],
      loading: false
    };

    room.players[socket.id] = {
      id: socket.id, name: sanitize(name) || 'لاعب', team: 0, isHost: true
    };

    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;

    cb({ ok: true, code, room: publicRoom(room) });
  });

  socket.on('join-room', ({ name, code }, cb) => {
    code = String(code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return cb({ ok: false, error: 'الغرفة غير موجودة' });
    if (room.status !== 'lobby') return cb({ ok: false, error: 'اللعبة بدأت بالفعل' });
    if (Object.keys(room.players).length >= 4) return cb({ ok: false, error: 'الغرفة ممتلئة (4 لاعبين)' });

    const counts = [0, 0];
    Object.values(room.players).forEach(p => counts[p.team]++);
    const team = counts[0] <= counts[1] ? 0 : 1;

    room.players[socket.id] = {
      id: socket.id, name: sanitize(name) || 'لاعب', team, isHost: false
    };

    socket.join(code);
    socket.data.roomCode = code;

    io.to(code).emit('room-update', publicRoom(room));
    cb({ ok: true, code, room: publicRoom(room) });
  });

  socket.on('swap-team', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== 'lobby') return;
    const player = room.players[socket.id];
    if (!player) return;

    const newTeam = 1 - player.team;
    const counts = [0, 0];
    Object.values(room.players).forEach(p => { if (p.id !== socket.id) counts[p.team]++; });

    if (counts[newTeam] >= 2) {
      socket.emit('error-msg', 'الفريق التاني مليان');
      return;
    }

    player.team = newTeam;
    io.to(room.code).emit('room-update', publicRoom(room));
  });

  socket.on('set-team-name', ({ teamIdx, name }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== 'lobby') return;
    const player = room.players[socket.id];
    if (!player || player.team !== teamIdx) return;

    const first = firstPlayerInTeam(room, teamIdx);
    if (!first || first.id !== socket.id) return;

    room.teamNames[teamIdx] = sanitize(name, 15);
    io.to(room.code).emit('room-update', publicRoom(room));
  });

  socket.on('start-setup', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id) return;

    const total = Object.keys(room.players).length;

    if (total < 2) {
      socket.emit('error-msg', 'محتاج لاعب تاني على الأقل');
      return;
    }
    if (total === 3) {
      socket.emit('error-msg', 'ناقص واحد عشان تبدأ (محتاج 2 أو 4 لاعبين)');
      return;
    }

    const counts = [0, 0];
    Object.values(room.players).forEach(p => counts[p.team]++);
    const perTeam = total / 2;
    if (counts[0] !== perTeam || counts[1] !== perTeam) {
      socket.emit('error-msg', `الفريقين مش متوازنين — لازم ${perTeam} في كل فريق`);
      return;
    }

    computeFinalTeamNames(room);

    room.status = 'setup';
    room.teams[0].balance = START_BALANCE;
    room.teams[1].balance = START_BALANCE;
    broadcast(room);
  });

  socket.on('set-categories', ({ categories }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id) return;
    if (!Array.isArray(categories) || categories.length < 1) return;
    room.categories = categories.filter(c => CATEGORIES[c]);
    if (room.categories.length < 1) return;
    startGame(room);
  });

  async function startGame(room) {
    room.status = 'playing';
    room.round = 1;
    room.startingTeam = 0;
    room.questions = [];
    room.askedQuestions = [];
    room.teams[0].balance = START_BALANCE;
    room.teams[1].balance = START_BALANCE;
    room.loading = true;
    broadcast(room);

    try {
      const qs = await generateQuestions(room.categories, []);
      room.questions = qs;
      room.loading = false;
      broadcast(room);
      if (qs.length > 0) {
        setTimeout(() => beginRound(room), 800);
      }
    } catch (e) {
      console.error('فشل بدء اللعبة:', e.message);
      room.loading = false;
      room.status = 'setup';
      io.to(room.hostId).emit('error-msg', 'فشل توليد الأسئلة، حاول تاني');
      broadcast(room);
    }
  }

  socket.on('bid', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;
    handleBid(room, player.team);
  });

  socket.on('pass', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;
    handlePass(room, player.team);
  });

  socket.on('answer', ({ correct }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;
    handleAnswer(room, player.team, !!correct);
  });

  socket.on('steal-decision', ({ accept }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const player = room.players[socket.id];
    if (!player || !room.auction) return;
    if (player.team !== room.auction.stealTeam) return;
    handleStealDecision(room, !!accept);
  });

  socket.on('steal-answer', ({ correct }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const player = room.players[socket.id];
    if (!player || !room.auction) return;
    if (player.team !== room.auction.stealTeam) return;
    handleStealAnswer(room, !!correct);
  });

  socket.on('chat', ({ text }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;
    const clean = String(text || '').trim().slice(0, 200);
    if (!clean) return;
    room.messages.push({
      name: player.name,
      team: player.team,
      text: clean,
      ts: Date.now()
    });
    if (room.messages.length > 100) room.messages = room.messages.slice(-100);
    io.to(room.code).emit('chat-msg', room.messages[room.messages.length - 1]);
  });

  socket.on('restart', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id) return;
    stopAuctionTimer(room);
    room.status = 'lobby';
    room.teams[0].balance = START_BALANCE;
    room.teams[1].balance = START_BALANCE;
    room.teams[0].name = 'الفريق الأول';
    room.teams[1].name = 'الفريق الثاني';
    room.teamNames = ['', ''];
    room.questions = [];
    room.askedQuestions = [];
    room.auction = null;
    room.round = 1;
    room.startingTeam = 0;
    broadcast(room);
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    delete room.players[socket.id];

    if (Object.keys(room.players).length === 0) {
      stopAuctionTimer(room);
      rooms.delete(code);
      return;
    }

    if (room.hostId === socket.id) {
      room.hostId = Object.keys(room.players)[0];
    }

    io.to(code).emit('room-update', publicRoom(room));
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎯 المزاد شغال على المنفذ ${PORT}`);
});