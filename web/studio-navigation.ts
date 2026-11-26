export const navigationMarkup = `<h1 class="studio-brand"><b><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h14M3 12h10M3 18h6"/></svg></b>Fleet Control</h1>
    <button type="button" data-view="workspaces"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z M3 9h18"/></svg>Workspaces</button>
    <label class="project-picker"><small>Active project</small><select id="studioProjects"><option value="">All projects</option></select></label>
    <button type="button" data-view="dashboard" aria-current="page"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 4h7v7H3z M14 4h7v7h-7z M3 15h7v6H3z M14 15h7v6h-7z"/></svg>Dashboard</button>
    <button type="button" data-view="tasks"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 7 2 2 3-4m3 2h10M3 16l2 2 3-4m3 2h10"/></svg>Tasks</button>
    <button type="button" data-view="decisions"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v15H4z M7 12l3 3 7-7"/></svg>Decisions <small id="decisionBadge" hidden></small></button>
    <button type="button" data-view="activity"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12h5l3-7 4 14 3-7h5"/></svg>Activity</button>
    <div class="infra-heading">Shared infrastructure</div>
    <button type="button" data-view="fleet"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 4h7v7H3z M14 4h7v7h-7z M3 15h7v6H3z M14 15h7v6h-7z"/></svg>Fleet</button>
    <button type="button" data-view="terminals"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 4h18v16H3z M6 9l3 3-3 3m6 0h5"/></svg>Terminals</button>
    <div class="sidebar" id="sidebar" aria-label="Hosts and sessions" role="group"></div>
    <div class="studio-rail-foot"><button type="button" data-view="settings"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h8m4 0h6M3 17h3m4 0h11 M11 4h4v6h-4z M6 14h4v6H6z"/></svg>Settings</button></div>`;
