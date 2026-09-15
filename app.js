(() => {
  'use strict';

  const DATA = window.FLOW_DATA;
  if (!DATA) throw new Error('FLOW_DATA не загружен');

  const $ = (id) => document.getElementById(id);
  const ui = {
    installBtn: $('installBtn'), settingsBtn: $('settingsBtn'), progressText: $('progressText'),
    progressPercent: $('progressPercent'), overallProgress: $('overallProgress'), exerciseType: $('exerciseType'),
    exerciseName: $('exerciseName'), stepPill: $('stepPill'), timerRing: $('timerRing'), timer: $('timer'),
    timerCaption: $('timerCaption'), stageProgress: $('stageProgress'), taskKicker: $('taskKicker'),
    taskText: $('taskText'), wordChips: $('wordChips'), extraText: $('extraText'), focusText: $('focusText'),
    startBtn: $('startBtn'), pauseBtn: $('pauseBtn'), refreshBtn: $('refreshBtn'), nextBtn: $('nextBtn'),
    sessionsStat: $('sessionsStat'), minutesStat: $('minutesStat'), streakStat: $('streakStat'), bankGrid: $('bankGrid'),
    settingsModal: $('settingsModal'), closeSettings: $('closeSettings'), saveSettings: $('saveSettings'),
    resetSettings: $('resetSettings'), quickSeconds: $('quickSeconds'), quickCount: $('quickCount'),
    forbiddenMinutes: $('forbiddenMinutes'), storyMinutes: $('storyMinutes'), twistInterval: $('twistInterval'),
    absurdMinutes: $('absurdMinutes'), boringMinutes: $('boringMinutes'), soundToggle: $('soundToggle'),
    wakeToggle: $('wakeToggle'), toast: $('toast')
  };

  const EXERCISES = [
    { name: 'Секунда на ответ', type: 'БЫСТРЫЕ ОТВЕТЫ' },
    { name: 'Запретное слово', type: 'ПЕРЕФОРМУЛИРОВКА' },
    { name: 'Случайный поворот', type: 'ИМПРОВИЗАЦИЯ' },
    { name: 'Защити абсурд', type: 'АРГУМЕНТАЦИЯ' },
    { name: 'Обычное → интересное', type: 'СТОРИТЕЛЛИНГ' }
  ];

  const DEFAULTS = {
    quickSeconds: 35,
    quickCount: 8,
    forbiddenMinutes: 5,
    storyMinutes: 5,
    twistInterval: 60,
    absurdMinutes: 5,
    boringMinutes: 5,
    sound: true,
    wakeLock: true
  };

  const PRESETS = {
    short: { quickSeconds: 25, quickCount: 6, forbiddenMinutes: 3, storyMinutes: 3, twistInterval: 45, absurdMinutes: 3, boringMinutes: 3 },
    normal: { quickSeconds: 35, quickCount: 8, forbiddenMinutes: 5, storyMinutes: 5, twistInterval: 60, absurdMinutes: 5, boringMinutes: 5 },
    long: { quickSeconds: 45, quickCount: 10, forbiddenMinutes: 8, storyMinutes: 8, twistInterval: 60, absurdMinutes: 8, boringMinutes: 8 }
  };

  const state = {
    settings: loadJSON('flow.settings', DEFAULTS),
    stats: loadJSON('flow.stats', { sessions: 0, minutes: 0, streak: 0, lastDate: null }),
    running: false,
    paused: false,
    exerciseIndex: 0,
    quickIndex: 0,
    quickQueue: [],
    storyTwists: [],
    storyTwistIndex: 0,
    nextTwistAt: 0,
    currentStoryStart: '',
    timerId: null,
    totalMs: 0,
    remainingMs: 0,
    endAt: 0,
    warningPlayed: false,
    timerDone: null,
    wakeLock: null,
    deferredInstall: null,
    audioContext: null,
    toastTimer: null
  };

  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? { ...fallback, ...JSON.parse(raw) } : { ...fallback };
    } catch (_) { return { ...fallback }; }
  }

  function saveJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
  }

  function clamp(n, min, max) {
    n = Number(n);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
  }

  function shuffle(items) {
    const a = [...items];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function randomItem(items, avoid = null) {
    if (!items.length) return null;
    if (items.length === 1) return items[0];
    let item;
    do item = items[Math.floor(Math.random() * items.length)];
    while (JSON.stringify(item) === JSON.stringify(avoid));
    return item;
  }

  function fmt(seconds) {
    seconds = Math.max(0, Math.ceil(seconds));
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function totalSessionSeconds() {
    const s = state.settings;
    return s.quickSeconds * s.quickCount + (s.forbiddenMinutes + s.storyMinutes + s.absurdMinutes + s.boringMinutes) * 60;
  }

  function exerciseDurations() {
    const s = state.settings;
    return [s.quickSeconds * s.quickCount, s.forbiddenMinutes * 60, s.storyMinutes * 60, s.absurdMinutes * 60, s.boringMinutes * 60];
  }

  function setChips(words = []) {
    ui.wordChips.innerHTML = '';
    words.forEach(word => {
      const el = document.createElement('span');
      el.className = 'word-chip';
      el.textContent = word;
      ui.wordChips.appendChild(el);
    });
  }

  function toast(message, ms = 2600) {
    clearTimeout(state.toastTimer);
    ui.toast.textContent = message;
    ui.toast.classList.remove('hidden');
    state.toastTimer = setTimeout(() => ui.toast.classList.add('hidden'), ms);
  }

  function setControls(mode) {
    const idle = mode === 'idle';
    const running = mode === 'running';
    const finished = mode === 'finished';
    ui.startBtn.classList.toggle('hidden', running);
    ui.pauseBtn.classList.toggle('hidden', !running);
    ui.refreshBtn.classList.toggle('hidden', !running);
    ui.nextBtn.classList.toggle('hidden', !running);
    if (idle) ui.startBtn.textContent = 'Начать тренировку';
    if (finished) ui.startBtn.textContent = 'Ещё одна тренировка';
  }

  function showWelcome() {
    stopTimer();
    state.running = false;
    state.paused = false;
    const total = totalSessionSeconds();
    ui.progressText.textContent = 'Тренировка не начата';
    ui.progressPercent.textContent = '0%';
    ui.overallProgress.style.width = '0%';
    ui.exerciseType.textContent = '5 УПРАЖНЕНИЙ ПО ПОРЯДКУ';
    ui.exerciseName.textContent = 'Готов начать?';
    ui.stepPill.textContent = '0 / 5';
    ui.timer.textContent = fmt(total);
    ui.timerCaption.textContent = 'вся тренировка';
    ui.timerRing.style.setProperty('--p', 0);
    ui.timerRing.classList.remove('warning');
    ui.stageProgress.style.width = '0%';
    ui.taskKicker.textContent = 'КАК ЭТО РАБОТАЕТ';
    ui.taskText.textContent = 'Нажми «Начать тренировку» — дальше программа сама проведёт тебя через все пять упражнений.';
    setChips([]);
    ui.extraText.textContent = `Примерная длительность: ${Math.round(total / 60)} мин. Все задания выбираются случайно и меняются при каждом запуске.`;
    ui.focusText.textContent = 'Говори вслух и не ищи идеальную формулировку. Цель — скорость, гибкость и уверенность.';
    setControls('idle');
    renderStats();
  }

  async function startTraining() {
    ensureAudio();
    state.running = true;
    state.paused = false;
    state.exerciseIndex = 0;
    state.quickIndex = 0;
    state.quickQueue = shuffle(DATA.QUICK_QUESTIONS).slice(0, state.settings.quickCount);
    setControls('running');
    ui.pauseBtn.textContent = 'Пауза';
    if (state.settings.wakeLock) requestWakeLock();
    startExercise(0);
  }

  function startExercise(index) {
    state.exerciseIndex = index;
    const ex = EXERCISES[index];
    ui.exerciseType.textContent = ex.type;
    ui.exerciseName.textContent = ex.name;
    ui.stepPill.textContent = `${index + 1} / 5`;
    ui.progressText.textContent = `Упражнение ${index + 1} из 5`;
    ui.timerRing.classList.remove('warning');
    setFocus(index);

    if (index === 0) startQuickQuestion(false);
    else if (index === 1) startForbidden(false);
    else if (index === 2) startStory(false);
    else if (index === 3) startAbsurd(false);
    else startBoring(false);
  }

  function setFocus(index) {
    const tips = DATA.FOCUS_TIPS[String(index)] || DATA.FOCUS_TIPS[index] || [];
    ui.focusText.textContent = tips.length ? randomItem(tips) : 'Продолжай говорить и развивай первую пришедшую мысль.';
  }

  function startQuickQuestion(refresh) {
    if (refresh) {
      const current = state.quickQueue[state.quickIndex];
      state.quickQueue[state.quickIndex] = randomItem(DATA.QUICK_QUESTIONS, current);
    }
    const question = state.quickQueue[state.quickIndex];
    ui.taskKicker.textContent = `ВОПРОС ${state.quickIndex + 1} ИЗ ${state.quickQueue.length}`;
    ui.taskText.textContent = question;
    setChips([]);
    ui.extraText.textContent = 'Начинай отвечать почти сразу. Тезис → причина → короткий пример.';
    ui.timerCaption.textContent = `вопрос ${state.quickIndex + 1} из ${state.quickQueue.length}`;
    startTimer(state.settings.quickSeconds, advanceQuick);
  }

  function advanceQuick() {
    beep('finish');
    state.quickIndex += 1;
    if (state.quickIndex < state.quickQueue.length) {
      startQuickQuestion(false);
    } else {
      advanceExercise();
    }
  }

  function startForbidden(refresh) {
    const current = refresh ? state.currentForbidden : null;
    state.currentForbidden = randomItem(DATA.FORBIDDEN_WORD_TASKS, current);
    const [topic, words] = state.currentForbidden;
    ui.taskKicker.textContent = 'ТЕМА';
    ui.taskText.textContent = topic;
    setChips(words);
    ui.extraText.textContent = 'Эти слова нельзя произносить. Если слово почти вырвалось — сразу переформулируй мысль.';
    ui.timerCaption.textContent = 'до следующего упражнения';
    startTimer(state.settings.forbiddenMinutes * 60, () => { beep('finish'); advanceExercise(); });
  }

  function startStory(refresh) {
    state.currentStoryStart = randomItem(DATA.STORY_STARTS, refresh ? state.currentStoryStart : null);
    state.storyTwists = shuffle(DATA.STORY_TWISTS);
    state.storyTwistIndex = 0;
    state.nextTwistAt = state.settings.twistInterval;
    ui.taskKicker.textContent = 'НАЧАЛО ИСТОРИИ';
    ui.taskText.textContent = state.currentStoryStart;
    setChips([]);
    ui.extraText.textContent = `Начинай рассказ. Новый поворот появится примерно каждые ${state.settings.twistInterval} сек.`;
    ui.timerCaption.textContent = 'история + повороты';
    startTimer(state.settings.storyMinutes * 60, () => { beep('finish'); advanceExercise(); });
  }

  function showStoryTwist(elapsedSec) {
    const twist = state.storyTwists[state.storyTwistIndex % state.storyTwists.length];
    state.storyTwistIndex += 1;
    while (state.nextTwistAt <= elapsedSec) state.nextTwistAt += state.settings.twistInterval;
    beep('normal');
    ui.taskKicker.textContent = `ПОВОРОТ ${state.storyTwistIndex}`;
    ui.taskText.textContent = twist;
    ui.extraText.textContent = `Не начинай заново. Встрой поворот в текущую историю. Начало: «${state.currentStoryStart}»`;
    setFocus(2);
  }

  function startAbsurd(refresh) {
    state.currentAbsurd = randomItem(DATA.ABSURD_POSITIONS, refresh ? state.currentAbsurd : null);
    ui.taskKicker.textContent = 'ТВОЯ ПОЗИЦИЯ';
    ui.taskText.textContent = state.currentAbsurd;
    setChips([]);
    ui.extraText.textContent = 'Защищай позицию уверенно: минимум три аргумента, пример и ответ на возможное возражение.';
    ui.timerCaption.textContent = 'до следующего упражнения';
    startTimer(state.settings.absurdMinutes * 60, () => { beep('finish'); advanceExercise(); });
  }

  function startBoring(refresh) {
    state.currentBoring = randomItem(DATA.BORING_SITUATIONS, refresh ? state.currentBoring : null);
    ui.taskKicker.textContent = 'СДЕЛАЙ ЭТО ИНТЕРЕСНЫМ';
    ui.taskText.textContent = state.currentBoring;
    setChips([]);
    ui.extraText.textContent = 'Добавь место, детали, наблюдения, маленькую проблему, диалог или неожиданное завершение.';
    ui.timerCaption.textContent = 'финальное упражнение';
    startTimer(state.settings.boringMinutes * 60, () => { beep('finish'); finishTraining(); });
  }

  function refreshCurrent() {
    if (!state.running || state.paused) return;
    if (state.exerciseIndex === 0) startQuickQuestion(true);
    else if (state.exerciseIndex === 1) startForbidden(true);
    else if (state.exerciseIndex === 2) startStory(true);
    else if (state.exerciseIndex === 3) startAbsurd(true);
    else startBoring(true);
    toast('Тема заменена — таймер начался заново');
  }

  function skipCurrent() {
    if (!state.running) return;
    if (state.exerciseIndex === 0) {
      stopTimer();
      state.quickIndex += 1;
      if (state.quickIndex < state.quickQueue.length) startQuickQuestion(false);
      else advanceExercise();
      return;
    }
    stopTimer();
    advanceExercise();
  }

  function advanceExercise() {
    stopTimer();
    const next = state.exerciseIndex + 1;
    if (next >= EXERCISES.length) return finishTraining();
    toast(`Дальше: ${EXERCISES[next].name}`, 1200);
    startExercise(next);
  }

  function finishTraining() {
    stopTimer();
    state.running = false;
    state.paused = false;
    releaseWakeLock();
    ui.progressText.textContent = 'Тренировка завершена';
    ui.progressPercent.textContent = '100%';
    ui.overallProgress.style.width = '100%';
    ui.stageProgress.style.width = '100%';
    ui.timerRing.style.setProperty('--p', 100);
    ui.timerRing.classList.remove('warning');
    ui.exerciseType.textContent = 'ГОТОВО';
    ui.exerciseName.textContent = 'Отличная работа';
    ui.stepPill.textContent = '5 / 5';
    ui.timer.textContent = '✓';
    ui.timerCaption.textContent = 'тренировка завершена';
    ui.taskKicker.textContent = 'СЕССИЯ ЗАКОНЧЕНА';
    ui.taskText.textContent = 'Ты прошёл все пять упражнений.';
    setChips([]);
    ui.extraText.textContent = 'Если хочется закрепить результат — завтра достаточно повторить ещё одну такую сессию.';
    ui.focusText.textContent = 'Регулярность важнее идеального выступления в одной тренировке.';
    setControls('finished');
    updateStatsAfterSession();
  }

  function startTimer(seconds, done) {
    stopTimer();
    state.totalMs = Math.max(1000, Number(seconds) * 1000);
    state.remainingMs = state.totalMs;
    state.endAt = Date.now() + state.remainingMs;
    state.warningPlayed = false;
    state.timerDone = done;
    tick();
    state.timerId = setInterval(tick, 250);
  }

  function stopTimer() {
    if (state.timerId) clearInterval(state.timerId);
    state.timerId = null;
    state.timerDone = null;
  }

  function tick() {
    if (!state.running || state.paused) return;
    state.remainingMs = Math.max(0, state.endAt - Date.now());
    const remainingSec = state.remainingMs / 1000;
    const elapsedSec = (state.totalMs - state.remainingMs) / 1000;
    ui.timer.textContent = fmt(remainingSec);

    const localPercent = state.totalMs ? Math.min(100, Math.max(0, elapsedSec / (state.totalMs / 1000) * 100)) : 0;
    ui.timerRing.style.setProperty('--p', localPercent.toFixed(2));
    ui.timerRing.classList.toggle('warning', remainingSec <= 10);

    if (!state.warningPlayed && remainingSec <= 5 && remainingSec > 0) {
      state.warningPlayed = true;
      beep('warning');
    }

    if (state.exerciseIndex === 2 && state.nextTwistAt > 0 && elapsedSec >= state.nextTwistAt && remainingSec > 2) {
      showStoryTwist(elapsedSec);
    }

    updateProgress(elapsedSec);

    if (state.remainingMs <= 0) {
      const done = state.timerDone;
      stopTimer();
      if (typeof done === 'function') done();
    }
  }

  function updateProgress(currentTaskElapsedSec) {
    const durations = exerciseDurations();
    const total = durations.reduce((a, b) => a + b, 0);
    let stageElapsed;
    if (state.exerciseIndex === 0) {
      stageElapsed = state.quickIndex * state.settings.quickSeconds + currentTaskElapsedSec;
    } else {
      stageElapsed = currentTaskElapsedSec;
    }
    const prior = durations.slice(0, state.exerciseIndex).reduce((a, b) => a + b, 0);
    const overallElapsed = prior + stageElapsed;
    const overallP = Math.min(100, overallElapsed / total * 100);
    const stageP = Math.min(100, stageElapsed / durations[state.exerciseIndex] * 100);
    ui.overallProgress.style.width = `${overallP}%`;
    ui.progressPercent.textContent = `${Math.floor(overallP)}%`;
    ui.stageProgress.style.width = `${stageP}%`;
  }

  function togglePause() {
    if (!state.running) return;
    if (!state.paused) {
      state.remainingMs = Math.max(0, state.endAt - Date.now());
      state.paused = true;
      if (state.timerId) clearInterval(state.timerId);
      state.timerId = null;
      ui.pauseBtn.textContent = 'Продолжить';
      ui.timerCaption.textContent = 'пауза';
      releaseWakeLock();
    } else {
      state.paused = false;
      state.endAt = Date.now() + state.remainingMs;
      state.timerId = setInterval(tick, 250);
      ui.pauseBtn.textContent = 'Пауза';
      if (state.settings.wakeLock) requestWakeLock();
      tick();
    }
  }

  function ensureAudio() {
    if (!state.settings.sound) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!state.audioContext) state.audioContext = new Ctx();
      if (state.audioContext.state === 'suspended') state.audioContext.resume();
    } catch (_) {}
  }

  function beep(kind = 'normal') {
    if (!state.settings.sound) return;
    ensureAudio();
    const ctx = state.audioContext;
    if (!ctx) return;
    const tones = kind === 'finish' ? [[900, .11], [1250, .16]] : kind === 'warning' ? [[720, .12]] : [[980, .1]];
    let offset = 0;
    tones.forEach(([freq, duration]) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + offset);
      gain.gain.exponentialRampToValueAtTime(0.14, ctx.currentTime + offset + .01);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + offset + duration);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + offset);
      osc.stop(ctx.currentTime + offset + duration + .02);
      offset += duration + .05;
    });
  }

  async function requestWakeLock() {
    if (!state.settings.wakeLock || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    try {
      state.wakeLock = await navigator.wakeLock.request('screen');
      state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
    } catch (_) {}
  }

  async function releaseWakeLock() {
    try { if (state.wakeLock) await state.wakeLock.release(); } catch (_) {}
    state.wakeLock = null;
  }

  function localDateString(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  }

  function dayDiff(a, b) {
    const [ay,am,ad] = a.split('-').map(Number);
    const [by,bm,bd] = b.split('-').map(Number);
    return Math.round((Date.UTC(by,bm-1,bd) - Date.UTC(ay,am-1,ad)) / 86400000);
  }

  function updateStatsAfterSession() {
    const today = localDateString();
    const prev = state.stats.lastDate;
    state.stats.sessions = (state.stats.sessions || 0) + 1;
    state.stats.minutes = (state.stats.minutes || 0) + Math.round(totalSessionSeconds() / 60);
    if (!prev) state.stats.streak = 1;
    else {
      const diff = dayDiff(prev, today);
      if (diff === 1) state.stats.streak = (state.stats.streak || 0) + 1;
      else if (diff > 1) state.stats.streak = 1;
    }
    state.stats.lastDate = today;
    saveJSON('flow.stats', state.stats);
    renderStats();
  }

  function renderStats() {
    ui.sessionsStat.textContent = state.stats.sessions || 0;
    ui.minutesStat.textContent = state.stats.minutes || 0;
    ui.streakStat.textContent = state.stats.streak || 0;
  }

  function renderBank() {
    const items = [
      [DATA.QUICK_QUESTIONS.length, 'быстрых вопросов'],
      [DATA.FORBIDDEN_WORD_TASKS.length, 'тем без слов'],
      [DATA.STORY_STARTS.length, 'начал историй'],
      [DATA.STORY_TWISTS.length, 'поворотов'],
      [DATA.ABSURD_POSITIONS.length, 'абсурдных позиций'],
      [DATA.BORING_SITUATIONS.length, 'сюжетов']
    ];
    ui.bankGrid.innerHTML = items.map(([n, label]) => `<div class="bank-item"><strong>${n}</strong><span>${label}</span></div>`).join('');
  }

  function openSettings() {
    if (state.running) return toast('Настройки можно менять между тренировками');
    fillSettingsForm();
    ui.settingsModal.classList.remove('hidden');
  }

  function closeSettings() { ui.settingsModal.classList.add('hidden'); }

  function fillSettingsForm() {
    const s = state.settings;
    ui.quickSeconds.value = s.quickSeconds;
    ui.quickCount.value = s.quickCount;
    ui.forbiddenMinutes.value = s.forbiddenMinutes;
    ui.storyMinutes.value = s.storyMinutes;
    ui.twistInterval.value = s.twistInterval;
    ui.absurdMinutes.value = s.absurdMinutes;
    ui.boringMinutes.value = s.boringMinutes;
    ui.soundToggle.checked = !!s.sound;
    ui.wakeToggle.checked = !!s.wakeLock;
  }

  function readSettingsForm() {
    return {
      quickSeconds: clamp(ui.quickSeconds.value, 15, 120),
      quickCount: Math.round(clamp(ui.quickCount.value, 3, 20)),
      forbiddenMinutes: Math.round(clamp(ui.forbiddenMinutes.value, 1, 15)),
      storyMinutes: Math.round(clamp(ui.storyMinutes.value, 1, 15)),
      twistInterval: Math.round(clamp(ui.twistInterval.value, 20, 180)),
      absurdMinutes: Math.round(clamp(ui.absurdMinutes.value, 1, 15)),
      boringMinutes: Math.round(clamp(ui.boringMinutes.value, 1, 15)),
      sound: ui.soundToggle.checked,
      wakeLock: ui.wakeToggle.checked
    };
  }

  function saveSettingsFromForm() {
    state.settings = readSettingsForm();
    saveJSON('flow.settings', state.settings);
    closeSettings();
    showWelcome();
    toast('Настройки сохранены');
  }

  function applyPreset(name) {
    const p = PRESETS[name];
    if (!p) return;
    Object.entries(p).forEach(([key, value]) => {
      const map = { quickSeconds: ui.quickSeconds, quickCount: ui.quickCount, forbiddenMinutes: ui.forbiddenMinutes, storyMinutes: ui.storyMinutes, twistInterval: ui.twistInterval, absurdMinutes: ui.absurdMinutes, boringMinutes: ui.boringMinutes };
      if (map[key]) map[key].value = value;
    });
    toast(`Пресет выбран. Нажми «Сохранить».`, 1500);
  }

  async function installApp() {
    if (state.deferredInstall) {
      state.deferredInstall.prompt();
      await state.deferredInstall.userChoice.catch(() => null);
      state.deferredInstall = null;
      return;
    }
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (isIOS) toast('iPhone: Поделиться → «На экран Домой»', 5000);
    else toast('Открой меню браузера → «Установить приложение» / «Добавить на главный экран»', 5000);
  }

  function bindEvents() {
    ui.startBtn.addEventListener('click', startTraining);
    ui.pauseBtn.addEventListener('click', togglePause);
    ui.refreshBtn.addEventListener('click', refreshCurrent);
    ui.nextBtn.addEventListener('click', skipCurrent);
    ui.settingsBtn.addEventListener('click', openSettings);
    ui.closeSettings.addEventListener('click', closeSettings);
    ui.saveSettings.addEventListener('click', saveSettingsFromForm);
    ui.resetSettings.addEventListener('click', () => { state.settings = { ...DEFAULTS }; fillSettingsForm(); toast('Значения по умолчанию восстановлены'); });
    ui.settingsModal.addEventListener('click', (e) => { if (e.target === ui.settingsModal) closeSettings(); });
    ui.installBtn.addEventListener('click', installApp);
    document.querySelectorAll('[data-preset]').forEach(btn => btn.addEventListener('click', () => applyPreset(btn.dataset.preset)));

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      state.deferredInstall = e;
      ui.installBtn.classList.remove('hidden');
    });
    window.addEventListener('appinstalled', () => toast('Flow установлен на устройство'));

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && state.running && !state.paused) {
        if (state.settings.wakeLock) requestWakeLock();
        tick();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (!state.running || ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
      if (e.code === 'Space') { e.preventDefault(); togglePause(); }
      if (e.code === 'ArrowRight') { e.preventDefault(); skipCurrent(); }
      if (e.key.toLowerCase() === 'r') { e.preventDefault(); refreshCurrent(); }
    });
  }

  function registerServiceWorker() {
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
  }

  function init() {
    ui.installBtn.classList.remove('hidden');
    renderBank();
    renderStats();
    bindEvents();
    registerServiceWorker();
    showWelcome();
  }

  init();
})();
