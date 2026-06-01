const DEFAULT_PROMPT = 'אתה עוזר לתקן שיבושי תמלול של דיבור לטקסט בעברית. תקן שגיאות כתיב, חלוקת מילים שגויה ושיבושי הקלטה. החזר רק את הטקסט המתוקן, ללא הסברים.';

const recordBtn = document.getElementById('recordBtn');
const timer = document.getElementById('timer');
const hint = document.getElementById('hint');
const statusMsg = document.getElementById('statusMsg');
const statusText = document.getElementById('statusText');
const playerSection = document.getElementById('player-section');
const audioPlayer = document.getElementById('audioPlayer');
const resultSection = document.getElementById('result-section');
const rawTextarea = document.getElementById('rawTextarea');
const promptTextarea = document.getElementById('promptTextarea');
const correctBtn = document.getElementById('correctBtn');
const correctStatus = document.getElementById('correctStatus');
const correctedBlock = document.getElementById('corrected-block');
const correctedText = document.getElementById('correctedText');
const copyRawBtn = document.getElementById('copyRawBtn');
const copyBtn = document.getElementById('copyBtn');
const newBtn = document.getElementById('newBtn');
const historySection = document.getElementById('history-section');
const historyList = document.getElementById('historyList');
const micIcon = document.querySelector('.mic-icon');
const stopIcon = document.querySelector('.stop-icon');

let mediaRecorder = null;
let chunks = [];
let timerInterval = null;
let seconds = 0;
let db = null;
let currentBlobUrl = null;
let selectedId = null;
let currentRecordingId = null;

// --- IndexedDB ---

async function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('TapeDB', 1);
    req.onupgradeneeded = e => {
      const database = e.target.result;
      if (!database.objectStoreNames.contains('recordings')) {
        database.createObjectStore('recordings', { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

function dbOp(mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('recordings', mode);
    const store = tx.objectStore('recordings');
    const req = fn(store);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

const saveRecording = data => dbOp('readwrite', store => store.add(data));
const updateRecording = data => dbOp('readwrite', store => store.put(data));
const getRecording = id => dbOp('readonly', store => store.get(id));
const getAllRecordings = () => dbOp('readonly', store => store.getAll());

// --- Timer ---

function updateTimer() {
  seconds++;
  const m = String(Math.floor(seconds / 60)).padStart(2, '0');
  const s = String(seconds % 60).padStart(2, '0');
  timer.textContent = `${m}:${s}`;
}

// --- Status ---

function setStatus(msg) {
  statusText.textContent = msg;
  statusMsg.classList.remove('hidden');
}

function clearStatus() {
  statusMsg.classList.add('hidden');
}

// --- Audio Player ---

function setAudio(blob, mimeType) {
  if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
  const b = blob instanceof Blob ? blob : new Blob([blob], { type: mimeType });
  currentBlobUrl = URL.createObjectURL(b);
  audioPlayer.src = currentBlobUrl;
  playerSection.classList.remove('hidden');
}

// --- Show transcription (after recording) ---

function showTranscription(raw) {
  rawTextarea.value = raw;
  promptTextarea.value = DEFAULT_PROMPT;
  correctedBlock.classList.add('hidden');
  correctedText.value = '';
  resultSection.classList.remove('hidden');
}

// --- Show full result (transcription + correction, e.g. from history) ---

function showFullResult(raw, corrected, systemPrompt) {
  rawTextarea.value = raw;
  promptTextarea.value = systemPrompt || DEFAULT_PROMPT;
  if (corrected) {
    correctedText.value = corrected;
    correctedBlock.classList.remove('hidden');
  } else {
    correctedBlock.classList.add('hidden');
    correctedText.value = '';
  }
  resultSection.classList.remove('hidden');
}

// --- History ---

function formatDate(date) {
  return date.toLocaleDateString('he-IL', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

async function loadHistory() {
  const recordings = await getAllRecordings();
  if (recordings.length === 0) {
    historySection.classList.add('hidden');
    return;
  }
  historySection.classList.remove('hidden');
  historyList.innerHTML = '';
  [...recordings].reverse().forEach(rec => {
    const item = document.createElement('button');
    item.className = 'history-item' + (rec.id === selectedId ? ' selected' : '');
    item.dataset.id = rec.id;
    const previewSource = rec.correctedText || rec.rawText || '';
    const preview = previewSource.length > 60 ? previewSource.slice(0, 60) + '...' : previewSource;
    item.innerHTML = `
      <span class="history-date">${formatDate(new Date(rec.timestamp))}</span>
      <span class="history-preview">${preview}</span>
    `;
    item.addEventListener('click', () => selectRecording(rec.id));
    historyList.appendChild(item);
  });
}

async function selectRecording(id) {
  selectedId = id;
  currentRecordingId = id;
  const rec = await getRecording(id);
  setAudio(rec.audioBlob, rec.mimeType);
  showFullResult(rec.rawText, rec.correctedText, rec.systemPrompt);
  document.querySelectorAll('.history-item').forEach(item => {
    item.classList.toggle('selected', Number(item.dataset.id) === id);
  });
}

// --- Reset ---

function resetUI() {
  recordBtn.classList.remove('recording');
  micIcon.classList.remove('hidden');
  stopIcon.classList.add('hidden');
  timer.classList.add('hidden');
  hint.textContent = 'לחץ להקלטה';
  clearStatus();
  seconds = 0;
  timer.textContent = '00:00';
}

// --- Recording ---

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    mediaRecorder = new MediaRecorder(stream);

    mediaRecorder.ondataavailable = e => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      clearInterval(timerInterval);

      const mimeType = mediaRecorder.mimeType || 'audio/webm';
      const blob = new Blob(chunks, { type: mimeType });
      const ext = mimeType.includes('ogg') ? '.ogg' : mimeType.includes('mp4') ? '.mp4' : '.webm';

      resetUI();
      setAudio(blob, mimeType);
      await processAudio(blob, ext, mimeType);
    };

    mediaRecorder.start();
    recordBtn.classList.add('recording');
    micIcon.classList.add('hidden');
    stopIcon.classList.remove('hidden');
    timer.classList.remove('hidden');
    hint.textContent = 'לחץ לעצירה';
    resultSection.classList.add('hidden');

    seconds = 0;
    timerInterval = setInterval(updateTimer, 1000);
  } catch (err) {
    alert('לא ניתן לגשת למיקרופון: ' + err.message);
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
}

recordBtn.addEventListener('click', () => {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    stopRecording();
  } else {
    startRecording();
  }
});

// --- Transcribe (no auto-correction) ---

async function processAudio(blob, ext, mimeType) {
  try {
    setStatus('מעלה הקלטה...');
    const formData = new FormData();
    formData.append('audio', blob, `recording${ext}`);

    const uploadRes = await fetch('/transcribe', { method: 'POST', body: formData });
    if (!uploadRes.ok) throw new Error('שגיאה בהעלאת הקלטה');
    const { jobId } = await uploadRes.json();

    setStatus('מתמלל...');
    const rawTranscription = await pollStatus(jobId);

    clearStatus();
    showTranscription(rawTranscription);

    const id = await saveRecording({
      timestamp: new Date().toISOString(),
      rawText: rawTranscription,
      correctedText: null,
      systemPrompt: null,
      audioBlob: blob,
      mimeType,
    });
    selectedId = id;
    currentRecordingId = id;
    await loadHistory();
  } catch (err) {
    clearStatus();
    alert('שגיאה: ' + err.message);
  }
}

async function pollStatus(jobId) {
  while (true) {
    await new Promise(r => setTimeout(r, 2000));
    const res = await fetch(`/status/${jobId}`);
    if (!res.ok) throw new Error('שגיאה בתמלול');
    const data = await res.json();
    if (data.status === 'COMPLETED') return data.text;
    if (data.status === 'FAILED') throw new Error(data.error || 'התמלול נכשל');
  }
}

// --- Manual correction ---

correctBtn.addEventListener('click', async () => {
  const text = rawTextarea.value.trim();
  if (!text) return;

  const systemPrompt = promptTextarea.value.trim() || DEFAULT_PROMPT;

  correctBtn.disabled = true;
  correctStatus.classList.remove('hidden');

  try {
    const res = await fetch('/correct', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, systemPrompt }),
    });
    if (!res.ok) throw new Error('שגיאה בתיקון טקסט');
    const { corrected } = await res.json();

    correctedText.value = corrected;
    correctedBlock.classList.remove('hidden');

    if (currentRecordingId) {
      const rec = await getRecording(currentRecordingId);
      if (rec) {
        rec.correctedText = corrected;
        rec.systemPrompt = systemPrompt;
        await updateRecording(rec);
        await loadHistory();
      }
    }
  } catch (err) {
    alert('שגיאה: ' + err.message);
  } finally {
    correctBtn.disabled = false;
    correctStatus.classList.add('hidden');
  }
});

// --- Buttons ---

copyRawBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(rawTextarea.value).then(() => {
    copyRawBtn.textContent = 'הועתק!';
    setTimeout(() => { copyRawBtn.textContent = 'העתק'; }, 2000);
  });
});

copyBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(correctedText.value).then(() => {
    copyBtn.textContent = 'הועתק!';
    setTimeout(() => { copyBtn.textContent = 'העתק'; }, 2000);
  });
});

newBtn.addEventListener('click', () => {
  resultSection.classList.add('hidden');
  rawTextarea.value = '';
  correctedText.value = '';
  correctedBlock.classList.add('hidden');
  currentRecordingId = null;
});

// --- Init ---

(async () => {
  db = await openDB();
  await loadHistory();
})();
