const form = document.querySelector('#loginForm');
const error = document.querySelector('#loginError');

function loginReturnTo() {
  const value = new URLSearchParams(window.location.search).get('returnTo') || '/';
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  error.textContent = '';
  const formData = new FormData(form);
  const response = await fetch('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.fromEntries(formData.entries()))
  });

  if (response.ok) {
    window.location.href = loginReturnTo();
    return;
  }

  const payload = await response.json().catch(() => ({}));
  error.textContent = payload.error || 'Login failed';
});
