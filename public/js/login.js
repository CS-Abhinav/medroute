if (Auth.token && Auth.user) location.href = Auth.home(Auth.user.role);

const hero = L.map('heroMap', { zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false })
  .setView(CHENNAI, 12);
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}').addTo(hero);

document.querySelectorAll('.demo-accounts button').forEach(b => b.onclick = () => {
  document.getElementById('username').value = b.dataset.u;
  document.getElementById('password').value = b.dataset.p;
});
document.getElementById('showRegister').onclick = e => { e.preventDefault(); loginView.classList.add('hidden'); registerView.classList.remove('hidden'); };
document.getElementById('showLogin').onclick = e => { e.preventDefault(); registerView.classList.add('hidden'); loginView.classList.remove('hidden'); };

document.getElementById('loginForm').onsubmit = async e => {
  e.preventDefault();
  loginError.textContent = '';
  try {
    const { token, user } = await api('/api/auth/login', { method: 'POST', body: { username: username.value, password: password.value } });
    Auth.save(token, user);
    location.href = Auth.home(user.role);
  } catch (err) { loginError.textContent = err.message; }
};
document.getElementById('registerForm').onsubmit = async e => {
  e.preventDefault();
  regError.textContent = '';
  try {
    const { token, user } = await api('/api/auth/register', { method: 'POST', body: { name: rName.value, phone: rPhone.value, username: rUser.value, password: rPass.value } });
    Auth.save(token, user);
    location.href = Auth.home(user.role);
  } catch (err) { regError.textContent = err.message; }
};
