const summaryRef = document.getElementById("landingSummary");

async function refreshLanding() {
  const data = await api("/api/bootstrap");
  summaryRef.textContent =
    `${data.stats.totalRestaurants} restoran, ${data.stats.activeCouriers} aktif kurye ve ${data.stats.totalPackages} aktif siparis RESTOMAP omurgasinda calisiyor.`;
}

refreshLanding().catch((error) => {
  summaryRef.textContent = error.message;
});
