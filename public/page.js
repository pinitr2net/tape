const DEFAULT_PROMPT = 'אתה עוזר לתקן שיבושי תמלול של דיבור לטקסט בעברית. תקן שגיאות כתיב, חלוקת מילים שגויה ושיבושי הקלטה. החזר רק את הטקסט המתוקן, ללא הסברים.';

const slug = decodeURIComponent(window.location.pathname.split('/p/')[1] || '');

const recordBtn = document.getElementById('recordBtn');
const timer = document.getElementById('timer');
const hint = document.getElementById('hint');
const uploadLabel = document.getElementById('uploadLabel');
const fileInput = document.getElementById('fileInput');
const autoTranscribeCheck = document.getElementById('autoTranscribeCheck');
const statusMsg = document.getElementById('statusMsg');
const statusText = document.getElementById('statusText');
const playerSection = document.getElementById('player-section');
const audioPlayer = document.getElementById('audioPlayer');
const transcribeBtn = document.getElementById('transcribeBtn');
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
const recordingsSection = document.getElementById('recordings-section');
const recordingsList = document.getElementById('recordingsList');
const micIcon = document.querySelector('.mic-icon');
const stopIcon = document.querySelector('.stop-icon');

let mediaRecorder = null;
let chunks = [];
let timerInterval = null;
let seconds = 0;
let currentBlobUrl = null;
let currentRecordingId = null;
let pendingBlob = null;
let pendingExt = null;
let pendingMimeType = null;

// --- Page init ---

function initPage() {
  document.getElementById('pageTitle').textContent = slug;
  document.title = `Tape — ${slug}`;
  loadRecordings();
}

// --- Recordings list ---

async function loadRecordings() {
  try {
    const res = await fetch(`/api/pages/${encodeURIComponent(slug)}`);
    if (!res.ok) return;
    const data = await res.json();
    renderRecordings(data.recordings);
  } catch (err) {
    console.error('Failed to load recordings:', err);
  }
}

function renderRecordings(recordings) {
  if (!recordings.length) {
    recordingsSection.classList.add('hidden');
    return;
  }
  recordingsSection.classList.remove('hidden');
  recordingsList.innerHTML = '';
  recordings.forEach(rec => {
    recordingsList.appendChild(createRecordingCard(rec));
  });
}

function createRecordingCard(rec) {
  const card = document.createElement('div');
  card.className = 'recording-card';
  card.dataset.id = rec.id;

  const preview = (rec.corrected_text || rec.raw_text || '').slice(0, 70);
  const date = new Date(rec.created_at).toLocaleDateString('he-IL', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });

  card.innerHTML = `
    <div class="rc-header">
      <div class="rc-meta">
        <span class="rc-date">${date}</span>
        <span class="rc-preview">${preview || 'ללא טקסט'}</span>
      </div>
      <button class="rc-delete" title="מחק">×</button>
    </div>
    <div class="rc-body hidden">
      ${rec.audio_url ? `<audio controls src="${rec.audio_url}" class="rc-audio"></audio>` : ''}
      ${rec.raw_text ? `
        <div class="rc-text-block">
          <div class="rc-text-header">
            <span>תמלול</span>
            <button class="btn-secondary rc-copy-raw">העתק</button>
          </div>
          <textarea class="result-text rc-raw">${rec.raw_text}</textarea>
        </div>
        <details class="raw-details rc-prompt-details">
          <summary>פרומפט לתיקון</summary>
          <textarea class="prompt-text rc-prompt">${rec.system_prompt || DEFAULT_PROMPT}</textarea>
        </details>
        <div class="correct-row">
          <button class="btn-primary rc-correct">תקן טקסט</button>
          <div class="status-msg rc-correct-status hidden">
            <div class="spinner"></div>
            <span>מתקן...</span>
          </div>
        </div>
      ` : ''}
      <div class="rc-corrected-block ${rec.corrected_text ? '' : 'hidden'}">
        <div class="rc-text-header">
          <span>טקסט מתוקן</span>
          <button class="btn-secondary rc-copy-corrected">העתק</button>
        </div>
        <textarea class="result-text rc-corrected" readonly>${rec.corrected_text || ''}</textarea>
      </div>
    </div>
  `;

  card.querySelector('.rc-header').addEventListener('click', e => {
    if (e.target.classList.contains('rc-delete')) return;
    card.querySelector('.rc-body').classList.toggle('hidden');
  });

  card.querySelector('.rc-delete').addEventListener('click', () => deleteCard(card, rec.id));

  const copyRaw = card.querySelector('.rc-copy-raw');
  if (copyRaw) {
    copyRaw.addEventListener('click', () => {
      navigator.clipboard.writeText(card.querySelector('.rc-raw').value).then(() => {
        copyRaw.textContent = 'הועתק!';
        setTimeout(() => { copyRaw.textContent = 'העתק'; }, 2000);
      });
    });
  }

  const copyCorrected = card.querySelector('.rc-copy-corrected');
  if (copyCorrected) {
    copyCorrected.addEventListener('click', () => {
      navigator.clipboard.writeText(card.querySelector('.rc-corrected').value).then(() => {
        copyCorrected.textContent = 'הועתק!';
        setTimeout(() => { copyCorrected.textContent = 'העתק'; }, 2000);
      });
    });
  }

  const rcCorrectBtn = card.querySelector('.rc-correct');
  if (rcCorrectBtn) {
    rcCorrectBtn.addEventListener('click', () => runCardCorrection(card, rec.id));
  }

  return card;
}

async function deleteCard(card, id) {
  await fetch(`/api/recordings/${id}`, { method: 'DELETE' });
  card.remove();
  if (!document.querySelectorAll('.recording-card').length) {
    recordingsSection.classList.add('hidden');
  }
}

async function runCardCorrection(card, id) {
  const rawEl = card.querySelector('.rc-raw');
  const promptEl = card.querySelector('.rc-prompt');
  const correctBtnEl = card.querySelector('.rc-correct');
  const correctStatusEl = card.querySelector('.rc-correct-status');
  const correctedBlock = card.querySelector('.rc-corrected-block');
  const correctedEl = card.querySelector('.rc-corrected');

  const text = rawEl?.value?.trim();
  if (!text) return;

  const systemPrompt = promptEl?.value?.trim() || DEFAULT_PROMPT;
  correctBtnEl.disabled = true;
  correctStatusEl.classList.remove('hidden');

  try {
    const res = await fetch('/correct', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, systemPrompt, recordingId: id }),
    });
    if (!res.ok) throw new Error('שגיאה בתיקון');
    const { corrected } = await res.json();
    correctedEl.value = corrected;
    correctedBlock.classList.remove('hidden');
  } catch (err) {
    alert('שגיאה: ' + err.message);
  } finally {
    correctBtnEl.disabled = false;
    correctStatusEl.classList.add('hidden');
  }
}

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

function afterAudioReady(blob, ext, mimeType) {
  setAudio(blob, mimeType);
  resultSection.classList.add('hidden');

  if (autoTranscribeCheck.checked) {
    transcribeBtn.classList.add('hidden');
    runTranscription(blob, ext, mimeType);
  } else {
    pendingBlob = blob;
    pendingExt = ext;
    pendingMimeType = mimeType;
    transcribeBtn.classList.remove('hidden');
  }
}

function showTranscription(raw) {
  rawTextarea.value = raw;
  promptTextarea.value = DEFAULT_PROMPT;
  correctedBlock.classList.add('hidden');
  correctedText.value = '';
  resultSection.classList.remove('hidden');
}

// --- Reset ---

function resetUI() {
  recordBtn.classList.remove('recording');
  micIcon.classList.remove('hidden');
  stopIcon.classList.add('hidden');
  timer.classList.add('hidden');
  uploadLabel.style.display = '';
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
      afterAudioReady(blob, ext, mimeType);
    };

    mediaRecorder.start();
    recordBtn.classList.add('recording');
    micIcon.classList.add('hidden');
    stopIcon.classList.remove('hidden');
    timer.classList.remove('hidden');
    uploadLabel.style.display = 'none';
    hint.textContent = 'לחץ לעצירה';

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

// --- File Upload ---

fileInput.addEventListener('change', e => {
  const file = e.target.files[0];
  fileInput.value = '';
  if (!file) return;

  const mimeType = file.type || 'audio/webm';
  const nameParts = file.name.split('.');
  const ext = nameParts.length > 1 ? '.' + nameParts.pop() : '.bin';

  afterAudioReady(file, ext, mimeType);
});

// --- Manual transcribe button ---

transcribeBtn.addEventListener('click', () => {
  if (!pendingBlob) return;
  transcribeBtn.classList.add('hidden');
  runTranscription(pendingBlob, pendingExt, pendingMimeType);
  pendingBlob = null;
});

// --- Transcription ---

async function runTranscription(blob, ext, mimeType) {
  try {
    setStatus('מעלה קובץ...');
    const formData = new FormData();
    formData.append('audio', blob, `recording${ext}`);
    formData.append('pageSlug', slug);

    const uploadRes = await fetch('/transcribe', { method: 'POST', body: formData });
    if (!uploadRes.ok) throw new Error('שגיאה בהעלאה');
    const { jobId, recordingId } = await uploadRes.json();
    currentRecordingId = recordingId;

    setStatus('מתמלל...');
    const rawTranscription = await pollStatus(jobId);

    clearStatus();
    showTranscription(rawTranscription);
    await loadRecordings();
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

// --- Correction ---

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
      body: JSON.stringify({ text, systemPrompt, recordingId: currentRecordingId }),
    });
    if (!res.ok) throw new Error('שגיאה בתיקון טקסט');
    const { corrected } = await res.json();

    correctedText.value = corrected;
    correctedBlock.classList.remove('hidden');
    await loadRecordings();
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
  transcribeBtn.classList.add('hidden');
  rawTextarea.value = '';
  correctedText.value = '';
  correctedBlock.classList.add('hidden');
  currentRecordingId = null;
  pendingBlob = null;
  if (currentBlobUrl) { URL.revokeObjectURL(currentBlobUrl); currentBlobUrl = null; }
  audioPlayer.src = '';
  playerSection.classList.add('hidden');
});

// --- Init ---

initPage();
