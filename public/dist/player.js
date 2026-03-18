// public/js/player.ts
var root = document.getElementById("player-root");
if (root) {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const link = fragment.get("link") ?? "";
  const name = fragment.get("name") ?? "Player";
  if (!link) {
    root.textContent = "Invalid invite link.";
  } else {
    root.textContent = `Welcome, ${name}. Player view coming soon.`;
  }
}
