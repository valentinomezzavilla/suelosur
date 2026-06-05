(function() {
    const btn = document.getElementById("toggleSidebar");
    const sidebar = document.getElementById("sidebar");
    if (!btn || !sidebar) return;

    const SIDEBAR_WIDTH = 240;

    btn.addEventListener("click", () => {
        sidebar.classList.toggle("active");
        btn.style.left = sidebar.classList.contains("active") ? (SIDEBAR_WIDTH + 12) + "px" : "16px";
    });

    // marco el link activo segun la URL
    document.querySelectorAll(".sidebar__link").forEach(link => {
        if (link.getAttribute("href") === window.location.pathname) {
            link.classList.add("is-active");
        }
    });
})();
