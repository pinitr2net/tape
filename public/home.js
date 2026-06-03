const pageNameInput = document.getElementById('pageNameInput');
const createPageBtn = document.getElementById('createPageBtn');
const createError = document.getElementById('createError');
const pagesSection = document.getElementById('pages-section');
const pagesList = document.getElementById('pagesList');

function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString('he-IL', {
    day: '2-digit', month: '2-digit', year: '2-digit',
  });
}

async function loadPages() {
  try {
    const res = await fetch('/api/pages');
    const pages = await res.json();
    if (!pages.length) {
      pagesSection.classList.add('hidden');
      return;
    }
    pagesSection.classList.remove('hidden');
    pagesList.innerHTML = '';
    pages.forEach(page => {
      const card = document.createElement('a');
      card.className = 'page-card';
      card.href = `/p/${encodeURIComponent(page.slug)}`;
      card.innerHTML = `
        <span class="page-card-name">${page.slug}</span>
        <span class="page-card-date">${formatDate(page.created_at)}</span>
      `;
      pagesList.appendChild(card);
    });
  } catch (err) {
    console.error('Failed to load pages:', err);
  }
}

async function createPage() {
  const slug = pageNameInput.value.trim();
  if (!slug) return;

  createError.classList.add('hidden');
  createPageBtn.disabled = true;

  try {
    const res = await fetch('/api/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug }),
    });
    const data = await res.json();
    if (!res.ok) {
      createError.textContent = data.error || 'שגיאה ביצירת הדף';
      createError.classList.remove('hidden');
      return;
    }
    window.location.href = `/p/${encodeURIComponent(data.slug)}`;
  } catch (err) {
    createError.textContent = 'שגיאת רשת';
    createError.classList.remove('hidden');
  } finally {
    createPageBtn.disabled = false;
  }
}

createPageBtn.addEventListener('click', createPage);
pageNameInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') createPage();
});

loadPages();
