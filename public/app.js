const recordBtn = document.getElementById('recordBtn');
const timer = document.getElementById('timer');
const hint = document.getElementById('hint');
const statusMsg = document.getElementById('statusMsg');
const statusText = document.getElementById('statusText');
const resultSection = document.getElementById('result-section');
const resultText = document.getElementById('resultText');
const copyBtn = document.getElementById('copyBtn');
const newBtn = document.getElementById('newBtn');
const micIcon = document.querySelector('.mic-icon');
const stopIcon = document.querySelector('.stop-icon');

let mediaRecorder = null;
let chunks = [];
let timerInterval = null;
let seconds = 0;

function updateTimer() {
  seconds++;
  const m = String(Math.floor(seconds / 60)).padStart(2, '0');
  const s = String(seconds % 60).padStart(2, '0');
  timer.textContent = `${m}:${s}`;
}

function setStatus(msg) {
  statusText.textContent = msg;
  statusMsg.classList.remove('hidden');
}

function clearStatus() {
  statusMsg.classList.add('hidden');
}

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
      await processAudio(blob, ext);
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

async function processAudio(blob, ext) {
  try {
    setStatus('מעלה הקלטה...');
    const formData = new FormData();
    formData.append('audio', blob, `recording${ext}`);

    const uploadRes = await fetch('/transcribe', { method: 'POST', body: formData });
    if (!uploadRes.ok) throw new Error('שגיאה בהעלאת הקלטה');
    const { jobId } = await uploadRes.json();

    setStatus('מתמלל...');
    const text = await pollStatus(jobId);

    setStatus('מתקן טקסט...');
    const correctRes = await fetch('/correct', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!correctRes.ok) throw new Error('שגיאה בתיקון טקסט');
    const { corrected } = await correctRes.json();

    clearStatus();
    resultText.value = corrected;
    resultSection.classList.remove('hidden');
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

copyBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(resultText.value).then(() => {
    copyBtn.textContent = 'הועתק!';
    setTimeout(() => { copyBtn.textContent = 'העתק'; }, 2000);
  });
});

newBtn.addEventListener('click', () => {
  resultSection.classList.add('hidden');
  resultText.value = '';
});
