(function () {
  "use strict";

  // ========================================
  // STATE
  // ========================================
  const state = {
    fileName: "",
    fileSize: 0,
    headers: [],
    allRows: [],
    filteredRows: [],
    isInitialized: false,
    searchTerm: "",
    activeFilters: {}, // { column: Set(values) }
    sort: { column: null, dir: "asc" },
    visibleColumns: new Set(),
    columnOrder: [],
    view: "list",
    page: 1,
    pageSize: 21,
  };

  // ========================================
  // DOM
  // ========================================
  const $ = (id) => document.getElementById(id);
  const DOM = {
    grid: $("resultsGrid"),
    overviewPanel: $("overviewPanel"),
    emptyState: $("emptyState"),
    importState: $("importState"),
    fileName: $("fileName"),
    fileMeta: $("fileMeta"),
    searchInput: $("searchInput"),
    csvUpload: $("csvUpload"),
    filterBtn: $("filterBtn"),
    filterPanel: $("filterPanel"),
    filterCount: $("filterCount"),
    sortBtn: $("sortBtn"),
    sortPanel: $("sortPanel"),
    sortLabel: $("sortLabel"),
    columnsBtn: $("columnsBtn"),
    columnsCount: $("columnsCount"),
    panelColumnsCount: $("panelColumnsCount"),
    viewSwitch: $("viewSwitch"),
    activeFiltersBar: $("activeFiltersBar"),
    activePills: $("activePills"),
    clearFiltersBtn: $("clearFiltersBtn"),
    resetEmptyBtn: $("resetEmptyBtn"),
    paginationBar: $("paginationBar"),
    pgSummary: $("pgSummary"),
    pgControls: $("pgControls"),
    rightPanel: $("rightPanel"),
    collapsePanelBtn: $("collapsePanelBtn"),
    columnSearch: $("columnSearch"),
    columnList: $("columnList"),
    resetColumnsBtn: $("resetColumnsBtn"),
    summaryList: $("summaryList"),
    typesWrap: $("typesWrap"),
    themeToggle: $("themeToggle"),
    themeLabel: $("themeLabel"),
  };

  const ICON_BRANDS = [
    ["#6d5bf6", "#5b4cf0"],
    ["#f97316", "#ea580c"],
    ["#10b981", "#059669"],
    ["#3b82f6", "#2563eb"],
    ["#ec4899", "#db2777"],
    ["#f59e0b", "#d97706"],
    ["#06b6d4", "#0891b2"],
    ["#8b5cf6", "#7c3aed"],
  ];

  const TYPE_COLORS = {
    Text: "#6d5bf6",
    Number: "#34d399",
    URL: "#a855f7",
    Date: "#fbbf24",
    Other: "#60a5fa",
  };

  // ========================================
  // UTILITIES
  // ========================================
  function normalize(v) {
    return String(v == null ? "" : v)
      .trim()
      .toLowerCase();
  }

  function escapeHtml(str) {
    if (str == null) return "";
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function isLinkField(key) {
    return /link|url|website/i.test(key);
  }

  function isNumericField(key, sampleValues) {
    if (
      /difficulty|priority|rating|score|count|number|rank|level|years?/i.test(
        key,
      )
    )
      return true;
    const vals = sampleValues.filter((v) => v && v.trim() !== "").slice(0, 15);
    if (vals.length === 0) return false;
    return vals.every((v) => !isNaN(parseFloat(v)) && isFinite(v));
  }

  function isDateField(key) {
    return /date|created|updated|modified|timestamp/i.test(key);
  }

  function fieldIcon() {
    return `<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="9" cy="9" r="7"/><path d="M9 5v4M9 12v1"/></svg>`;
  }

  function formatBytes(bytes) {
    if (!bytes) return "0 KB";
    const kb = bytes / 1024;
    if (kb < 1024) return kb.toFixed(1) + " KB";
    return (kb / 1024).toFixed(1) + " MB";
  }

  function brandFor(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++)
      hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
    return ICON_BRANDS[hash % ICON_BRANDS.length];
  }

  function getPrimaryColumn() {
    const lower = state.headers.map((h) => h.toLowerCase());
    const candidates = ["tool", "name", "title", "product"];
    for (const c of candidates) {
      const idx = lower.indexOf(c);
      if (idx !== -1) return state.headers[idx];
    }
    return state.headers[0];
  }

  function getCategoricalColumns() {
    // columns with a reasonably small number of unique values, excluding primary/link/desc-like
    const primary = getPrimaryColumn();
    return state.headers.filter((h) => {
      if (h === primary) return false;
      if (isLinkField(h)) return false;
      const values = new Set(
        state.allRows.map((r) => (r[h] || "").trim()).filter(Boolean),
      );
      return values.size > 0 && values.size <= 30;
    });
  }

  // ========================================
  // CSV PARSER
  // ========================================
  function parseCSV(text) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      const next = text[i + 1];

      // handle escaped quote ""
      if (c === '"' && inQuotes && next === '"') {
        field += '"';
        i++;
        continue;
      }

      // toggle quotes
      if (c === '"') {
        inQuotes = !inQuotes;
        continue;
      }

      // field separator
      if (c === "," && !inQuotes) {
        row.push(field);
        field = "";
        continue;
      }

      // row separator (CRLF / LF)
      if ((c === "\n" || c === "\r") && !inQuotes) {
        if (c === "\r" && next === "\n") continue;

        row.push(field);
        rows.push(row);

        row = [];
        field = "";
        continue;
      }

      field += c;
    }

    // flush last field
    if (field.length > 0 || row.length > 0) {
      row.push(field);
      rows.push(row);
    }

    const headers = rows.shift().map((h) => h.trim());

    const data = rows.map((r) => {
      const obj = {};
      headers.forEach((h, i) => {
        obj[h] = r[i] ?? "";
      });
      return obj;
    });

    return { headers, rows: data };
  }

  function parseCSVLine(line) {
    const values = [];
    let current = "";
    let insideQuotes = false;
    for (let j = 0; j < line.length; j++) {
      const char = line[j];
      if (char === '"') {
        insideQuotes = !insideQuotes;
      } else if (char === "," && !insideQuotes) {
        values.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }
    values.push(current.trim());
    return values;
  }

  // ========================================
  // DATA LOADING
  // ========================================
  function loadCSVFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = e.target.result;
        const { headers, rows } = parseCSV(text);
        if (rows.length === 0) {
          alert("CSV is empty or malformed.");
          return;
        }

        state.fileName = file.name;
        state.fileSize = file.size;
        state.headers = headers;
        state.allRows = rows;
        state.isInitialized = true;
        state.activeFilters = {};
        state.searchTerm = "";
        state.sort = { column: null, dir: "asc" };
        state.page = 1;
        DOM.searchInput.value = "";

        const primary = getPrimaryColumn();
        state.columnOrder = [primary, ...headers.filter((h) => h !== primary)];
        state.visibleColumns = new Set(
          state.columnOrder
            .filter(
              (h) => !/^(why use it|alternative tools|best for)$/i.test(h),
            )
            .slice(0, 11),
        );
        if (state.visibleColumns.size === 0)
          state.visibleColumns = new Set(state.columnOrder);

        renderHeader();
        renderColumnsPanel();
        renderFilterPanel();
        renderSortPanel();
        applyFiltersAndRender();
      } catch (err) {
        alert("Error reading CSV: " + err.message);
      }
    };
    reader.onerror = () => alert("Error loading file.");
    reader.readAsText(file);
  }

  function renderHeader() {
    DOM.fileName.textContent = state.fileName;
    DOM.fileMeta.textContent = `${state.allRows.length.toLocaleString()} rows · ${state.headers.length} columns · ${formatBytes(state.fileSize)}`;
  }

  // ========================================
  // FILTER PANEL (multi-select per categorical column)
  // ========================================
  function renderFilterPanel() {
    const cols = getCategoricalColumns();
    if (cols.length === 0) {
      DOM.filterPanel.innerHTML = `<div class="dd-col-title">No filterable columns</div>`;
      return;
    }
    DOM.filterPanel.innerHTML = cols
      .map((col) => {
        const values = Array.from(
          new Set(
            state.allRows.map((r) => (r[col] || "").trim()).filter(Boolean),
          ),
        ).sort();
        const active = state.activeFilters[col] || new Set();
        return `
          <div class="dd-section">
            <div class="dd-col-title">${escapeHtml(col)}</div>
            ${values
              .map(
                (v) => `
              <label class="dd-option">
                <input type="checkbox" data-col="${escapeHtml(col)}" data-val="${escapeHtml(v)}" ${active.has(v) ? "checked" : ""} />
                <span>${escapeHtml(v)}</span>
              </label>`,
              )
              .join("")}
          </div>`;
      })
      .join("");

    DOM.filterPanel.querySelectorAll("input[type=checkbox]").forEach((cb) => {
      cb.addEventListener("change", function () {
        const col = this.dataset.col;
        const val = this.dataset.val;
        if (!state.activeFilters[col]) state.activeFilters[col] = new Set();
        if (this.checked) state.activeFilters[col].add(val);
        else state.activeFilters[col].delete(val);
        if (state.activeFilters[col].size === 0)
          delete state.activeFilters[col];
        state.page = 1;
        applyFiltersAndRender();
      });
    });
  }

  function renderSortPanel() {
    const cols = state.headers;
    DOM.sortPanel.innerHTML = `
      <div class="dd-col-title">Sort by</div>
      ${cols
        .map(
          (c) => `
        <div class="dd-radio-row ${state.sort.column === c ? "active" : ""}" data-col="${escapeHtml(c)}">
          <span>${escapeHtml(c)}</span>
        </div>`,
        )
        .join("")}
      ${
        state.sort.column
          ? `<div class="dd-section">
              <div class="dd-radio-row ${state.sort.dir === "asc" ? "active" : ""}" data-dir="asc"><span>Ascending</span></div>
              <div class="dd-radio-row ${state.sort.dir === "desc" ? "active" : ""}" data-dir="desc"><span>Descending</span></div>
              <div class="dd-radio-row" data-clear="1"><span>Clear sort</span></div>
            </div>`
          : ""
      }
    `;

    DOM.sortPanel.querySelectorAll("[data-col]").forEach((el) => {
      el.addEventListener("click", function () {
        state.sort.column = this.dataset.col;
        renderSortPanel();
        applyFiltersAndRender();
      });
    });
    DOM.sortPanel.querySelectorAll("[data-dir]").forEach((el) => {
      el.addEventListener("click", function () {
        state.sort.dir = this.dataset.dir;
        renderSortPanel();
        applyFiltersAndRender();
        closeAllDropdowns();
      });
    });
    const clearEl = DOM.sortPanel.querySelector("[data-clear]");
    if (clearEl) {
      clearEl.addEventListener("click", function () {
        state.sort = { column: null, dir: "asc" };
        renderSortPanel();
        applyFiltersAndRender();
        closeAllDropdowns();
      });
    }

    DOM.sortLabel.textContent = state.sort.column
      ? `${state.sort.column} ${state.sort.dir === "asc" ? "↑" : "↓"}`
      : "";
  }

  // ========================================
  // COLUMNS PANEL (right sidebar)
  // ========================================
  function renderColumnsPanel(filterText) {
    const primary = getPrimaryColumn();
    const term = normalize(filterText || "");
    const cols = state.columnOrder.filter(
      (c) => !term || normalize(c).includes(term),
    );

    DOM.columnList.innerHTML = cols
      .map(
        (col) => `
        <label class="column-row" draggable="true" data-col="${escapeHtml(col)}">
          <span class="drag-handle"><svg viewBox="0 0 18 18" fill="currentColor"><circle cx="6" cy="5" r="1.3"/><circle cx="6" cy="9" r="1.3"/><circle cx="6" cy="13" r="1.3"/><circle cx="12" cy="5" r="1.3"/><circle cx="12" cy="9" r="1.3"/><circle cx="12" cy="13" r="1.3"/></svg></span>
          <input type="checkbox" data-col="${escapeHtml(col)}" ${state.visibleColumns.has(col) ? "checked" : ""} ${col === primary ? "disabled checked" : ""} />
          <span class="col-name">${escapeHtml(col)}</span>
          ${col === primary ? `<span class="primary-tag">Primary</span>` : ""}
        </label>`,
      )
      .join("");

    DOM.columnList
      .querySelectorAll("input[type=checkbox]:not(:disabled)")
      .forEach((cb) => {
        cb.addEventListener("change", function () {
          const col = this.dataset.col;
          if (this.checked) state.visibleColumns.add(col);
          else state.visibleColumns.delete(col);
          updateColumnCounts();
          applyFiltersAndRender();
        });
      });

    updateColumnCounts();
  }

  function updateColumnCounts() {
    DOM.columnsCount.textContent = state.visibleColumns.size;
    DOM.panelColumnsCount.textContent = state.visibleColumns.size;
  }

  // ========================================
  // FILTER / SORT / SEARCH PIPELINE
  // ========================================
  function applyFiltersAndRender() {
    const search = normalize(state.searchTerm);
    let rows = state.allRows.filter((row) => {
      if (search) {
        const rowStr = Object.values(row).join(" ").toLowerCase();
        if (!rowStr.includes(search)) return false;
      }
      for (const [col, valSet] of Object.entries(state.activeFilters)) {
        if (!valSet.has((row[col] || "").trim())) return false;
      }
      return true;
    });

    if (state.sort.column) {
      const col = state.sort.column;
      const numeric = isNumericField(
        col,
        state.allRows.map((r) => r[col]),
      );
      rows = rows.slice().sort((a, b) => {
        let av = a[col] || "";
        let bv = b[col] || "";
        if (numeric) {
          av = parseFloat(av) || 0;
          bv = parseFloat(bv) || 0;
          return state.sort.dir === "asc" ? av - bv : bv - av;
        }
        av = normalize(av);
        bv = normalize(bv);
        if (av < bv) return state.sort.dir === "asc" ? -1 : 1;
        if (av > bv) return state.sort.dir === "asc" ? 1 : -1;
        return 0;
      });
    }

    state.filteredRows = rows;
    renderActiveFilterPills();
    render();
  }

  // ========================================
  // ACTIVE FILTER PILLS
  // ========================================
  function renderActiveFilterPills() {
    const entries = Object.entries(state.activeFilters).filter(
      ([, set]) => set.size > 0,
    );
    DOM.filterCount.textContent = entries.length;
    DOM.filterCount.classList.toggle("hidden", entries.length === 0);

    if (entries.length === 0) {
      DOM.activeFiltersBar.classList.add("hidden");
      DOM.activePills.innerHTML = "";
      return;
    }

    DOM.activeFiltersBar.classList.remove("hidden");
    DOM.activePills.innerHTML = entries
      .map(([col, set]) => {
        const vals = Array.from(set).join(", ");
        return `
        <span class="filter-pill" data-col="${escapeHtml(col)}">
          ${escapeHtml(col)} is ${escapeHtml(vals)}
          <button type="button" data-clear-col="${escapeHtml(col)}"><svg viewBox="0 0 10 10" stroke="currentColor" stroke-width="1.6"><path d="M1 1l8 8M9 1l-8 8"/></svg></button>
        </span>`;
      })
      .join("");

    DOM.activePills.querySelectorAll("[data-clear-col]").forEach((btn) => {
      btn.addEventListener("click", function () {
        delete state.activeFilters[this.dataset.clearCol];
        renderFilterPanel();
        state.page = 1;
        applyFiltersAndRender();
      });
    });
  }

  // ========================================
  // RENDER ENGINE
  // ========================================
  function render() {
    if (!state.isInitialized || state.allRows.length === 0) {
      DOM.importState.classList.remove("hidden");
      DOM.emptyState.classList.add("hidden");
      DOM.grid.classList.add("hidden");
      DOM.overviewPanel.classList.add("hidden");
      DOM.paginationBar.classList.add("hidden");
      return;
    }
    DOM.importState.classList.add("hidden");

    if (state.filteredRows.length === 0) {
      DOM.grid.classList.add("hidden");
      DOM.overviewPanel.classList.add("hidden");
      DOM.emptyState.classList.remove("hidden");
      DOM.paginationBar.classList.add("hidden");
      return;
    }
    DOM.emptyState.classList.add("hidden");

    if (state.view === "overview") {
      DOM.grid.classList.add("hidden");
      DOM.paginationBar.classList.add("hidden");
      DOM.overviewPanel.classList.remove("hidden");
      renderOverview();
      renderRightPanel();
      return;
    }

    DOM.overviewPanel.classList.add("hidden");
    DOM.grid.classList.remove("hidden");
    DOM.grid.className = "grid view-" + state.view;

    const pageRows =
      state.view === "table"
        ? state.filteredRows
        : paginate(state.filteredRows);

    if (state.view === "list")
      DOM.grid.innerHTML = pageRows.map(renderListRow).join("");
    else if (state.view === "cards") {
      DOM.grid.innerHTML = pageRows.map(renderCard).join("");
    } else if (state.view === "table")
      DOM.grid.innerHTML = renderTable(pageRows);

    renderPagination();
    renderRightPanel();
  }

  function paginate(rows) {
    const totalPages = Math.max(1, Math.ceil(rows.length / state.pageSize));
    if (state.page > totalPages) state.page = totalPages;
    const start = (state.page - 1) * state.pageSize;
    return rows.slice(start, start + state.pageSize);
  }

  function visibleFields(row) {
    return state.columnOrder.filter(
      (c) => state.visibleColumns.has(c) && c !== getPrimaryColumn(),
    );
  }

  function renderListRow(row) {
    const primary = getPrimaryColumn();
    const name = row[primary] || "Unnamed";
    const [c1, c2] = brandFor(name);
    const fields = visibleFields(row).slice(0, 4);
    const linkCol = state.headers.find((h) => isLinkField(h));

    const midHtml = fields
      .map((key) => {
        const val = (row[key] || "").trim();
        if (!val) return "";
        if (/difficulty/i.test(key) && isNumericField(key, [val])) {
          return scaleField(key, val, "");
        }
        if (/priority/i.test(key) && isNumericField(key, [val])) {
          return scaleField(key, val, "priority");
        }
        if (isLinkField(key)) return "";
        return `<div class="row-field"><div class="row-field-label">${escapeHtml(key)}</div><div class="row-field-value">${escapeHtml(val)}</div></div>`;
      })
      .join("");

    const linkVal = linkCol ? (row[linkCol] || "").trim() : "";

    return `
      <div class="row-card">
        <div class="row-icon" style="background:linear-gradient(135deg, ${c1}, ${c2})">${escapeHtml(name.slice(0, 2).toUpperCase())}</div>
        <div class="row-primary">
          <div class="row-name">${escapeHtml(name)} <span class="row-fav">☆</span></div>
          <div class="row-desc">${escapeHtml(firstDescriptiveValue(row))}</div>
        </div>
        <div class="row-mid">${midHtml}</div>
        ${
          linkVal
            ? `<a class="row-link" href="${escapeHtml(linkVal)}" target="_blank" rel="noopener noreferrer"><svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 11l6-6M9 4h5v5"/><path d="M13 10v3a1.5 1.5 0 0 1-1.5 1.5h-6A1.5 1.5 0 0 1 4 13V7a1.5 1.5 0 0 1 1.5-1.5h3"/></svg></a>`
            : ""
        }
      </div>`;
  }

  function scaleField(key, val, variant) {
    const n = Math.max(0, Math.min(5, parseInt(val, 10) || 0));
    let dots = "";
    for (let i = 1; i <= 5; i++)
      dots += `<span class="${i <= n ? "filled" : ""}"></span>`;
    return `<div class="row-field"><div class="row-field-label">${escapeHtml(key)}</div><div class="row-field-value"><span class="dot-scale ${variant}">${dots}</span> ${n}</div></div>`;
  }

  function firstDescriptiveValue(row) {
    const primary = getPrimaryColumn();
    const skip = new Set([primary]);
    for (const key of state.columnOrder) {
      if (skip.has(key)) continue;
      const v = (row[key] || "").trim();
      if (v && !isLinkField(key) && v.length > 12 && !/^\d+$/.test(v)) return v;
    }
    return "";
  }

  function renderCard(row) {
    const primary = getPrimaryColumn();
    const name = row[primary] || "Unnamed";
    const [c1, c2] = brandFor(name);

    const tagCols = state.headers.filter((h) => /role|category|type/i.test(h));
    const tags = tagCols.map((h) => (row[h] || "").trim()).filter(Boolean);

    const fieldsHtml = visibleFields(row)
      .filter((key) => !tagCols.includes(key))
      .map((key) => {
        const value = (row[key] || "").trim();
        if (!value) return "";

        const valueHtml = isLinkField(key)
          ? `<a href="${escapeHtml(value)}" target="_blank" rel="noopener noreferrer">${escapeHtml(value)}</a>`
          : escapeHtml(value);

        return `
        <div class="field-item">
          <span class="field-icon">${fieldIcon()}</span>
          <div>
            <span class="field-label">${escapeHtml(key)}</span>
            <span class="field-value">${valueHtml}</span>
          </div>
        </div>`;
      })
      .filter(Boolean)
      .join("");

    return `
    <div class="tool-card">
      <div class="tool-card-top">
        <div class="row-icon" style="background:linear-gradient(135deg, ${c1}, ${c2})">
          ${escapeHtml(name.slice(0, 2).toUpperCase())}
        </div>
        <div class="tool-name">${escapeHtml(name)}</div>
      </div>

      ${
        tags.length
          ? `
        <div class="tool-tags">
          ${tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("")}
        </div>
      `
          : ""
      }

      ${
        fieldsHtml
          ? `
        <div class="tool-fields">
          ${fieldsHtml}
        </div>
      `
          : ""
      }
    </div>
  `;
  }

  function renderTable(rows) {
    const cols = state.columnOrder.filter((c) => state.visibleColumns.has(c));
    const thead = `<thead><tr>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead>`;
    const tbody = rows
      .map((row) => {
        const tds = cols
          .map((c) => {
            const v = (row[c] || "").trim();
            const html =
              isLinkField(c) && v
                ? `<a href="${escapeHtml(v)}" target="_blank" rel="noopener noreferrer">${escapeHtml(v)}</a>`
                : escapeHtml(v);
            return `<td title="${escapeHtml(v)}">${html}</td>`;
          })
          .join("");
        return `<tr>${tds}</tr>`;
      })
      .join("");
    return `<div class="table-wrap"><table class="data-table">${thead}<tbody>${tbody}</tbody></table></div>`;
  }

  // ========================================
  // OVERVIEW VIEW
  // ========================================
  function renderOverview() {
    const total = state.allRows.length;
    const filtered = state.filteredRows.length;
    const cols = state.headers.length;

    let html = `
      <div class="overview-card"><div class="ov-num">${total.toLocaleString()}</div><div class="ov-label">Total Rows</div></div>
      <div class="overview-card"><div class="ov-num">${cols}</div><div class="ov-label">Total Columns</div></div>
      <div class="overview-card"><div class="ov-num">${filtered.toLocaleString()}</div><div class="ov-label">Filtered Rows</div></div>
      <div class="overview-card"><div class="ov-num">${formatBytes(state.fileSize)}</div><div class="ov-label">File Size</div></div>
    `;

    const catCols = getCategoricalColumns().slice(0, 3);
    catCols.forEach((col) => {
      const counts = {};
      state.allRows.forEach((r) => {
        const v = (r[col] || "").trim();
        if (!v) return;
        counts[v] = (counts[v] || 0) + 1;
      });
      const entries = Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6);
      const max = entries.length ? entries[0][1] : 1;
      html += `
        <div class="overview-card full">
          <div class="ov-label" style="margin-bottom:10px;font-weight:700;text-transform:uppercase;font-size:11px;letter-spacing:.4px;">${escapeHtml(col)} breakdown</div>
          <div class="ov-bars">
            ${entries
              .map(
                ([label, count]) => `
              <div class="ov-bar-row">
                <span>${escapeHtml(label)}</span>
                <div class="ov-bar-track"><div class="ov-bar-fill" style="width:${(count / max) * 100}%"></div></div>
                <span style="text-align:right;color:var(--text-secondary)">${count}</span>
              </div>`,
              )
              .join("")}
          </div>
        </div>`;
    });

    DOM.overviewPanel.innerHTML = html;
  }

  // ========================================
  // PAGINATION UI
  // ========================================
  function renderPagination() {
    const total = state.filteredRows.length;
    const totalPages = Math.max(1, Math.ceil(total / state.pageSize));

    if (state.view === "table") {
      DOM.paginationBar.classList.add("hidden");
      return;
    }

    DOM.paginationBar.classList.remove("hidden");
    const start = (state.page - 1) * state.pageSize + 1;
    const end = Math.min(total, state.page * state.pageSize);
    DOM.pgSummary.textContent = `Showing ${start} to ${end} of ${total.toLocaleString()} results`;

    let buttons = `<button class="pg-btn" data-pg="prev" ${state.page === 1 ? "disabled" : ""}><svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4l-5 5 5 5"/></svg></button>`;

    const pages = [];
    const p = state.page;
    pages.push(1);
    for (let i = p - 1; i <= p + 1; i++)
      if (i > 1 && i < totalPages) pages.push(i);
    if (totalPages > 1) pages.push(totalPages);
    const uniq = Array.from(new Set(pages)).sort((a, b) => a - b);

    let prev = 0;
    uniq.forEach((pg) => {
      if (pg - prev > 1) buttons += `<span class="pg-dots">…</span>`;
      buttons += `<button class="pg-btn ${pg === p ? "active" : ""}" data-pg="${pg}">${pg}</button>`;
      prev = pg;
    });

    buttons += `<button class="pg-btn" data-pg="next" ${state.page === totalPages ? "disabled" : ""}><svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 4l5 5-5 5"/></svg></button>`;

    DOM.pgControls.innerHTML = buttons;
    DOM.pgControls.querySelectorAll("[data-pg]").forEach((btn) => {
      btn.addEventListener("click", function () {
        const v = this.dataset.pg;
        if (v === "prev") state.page = Math.max(1, state.page - 1);
        else if (v === "next")
          state.page = Math.min(totalPages, state.page + 1);
        else state.page = parseInt(v, 10);
        render();
        DOM.grid.scrollIntoView({ block: "start" });
      });
    });
  }

  // ========================================
  // RIGHT PANEL: SUMMARY + TYPES
  // ========================================
  function renderRightPanel() {
    DOM.summaryList.innerHTML = `
      <div class="summary-row"><span>Total Rows</span><span>${state.allRows.length.toLocaleString()}</span></div>
      <div class="summary-row"><span>Total Columns</span><span>${state.headers.length}</span></div>
      <div class="summary-row"><span>Filtered Rows</span><span>${state.filteredRows.length.toLocaleString()}</span></div>
      <div class="summary-row"><span>File Size</span><span>${formatBytes(state.fileSize)}</span></div>
      <div class="summary-row"><span>Visible Columns</span><span>${state.visibleColumns.size}</span></div>
    `;

    const typeCounts = { Text: 0, Number: 0, URL: 0, Date: 0, Other: 0 };
    state.headers.forEach((h) => {
      const sample = state.allRows.map((r) => r[h]);
      if (isLinkField(h)) typeCounts.URL++;
      else if (isDateField(h)) typeCounts.Date++;
      else if (isNumericField(h, sample)) typeCounts.Number++;
      else typeCounts.Text++;
    });

    const entries = Object.entries(typeCounts).filter(([, v]) => v > 0);
    const total = entries.reduce((s, [, v]) => s + v, 0) || 1;

    let offset = 0;
    const r = 16;
    const circumference = 2 * Math.PI * r;
    const segments = entries
      .map(([label, count]) => {
        const frac = count / total;
        const len = frac * circumference;
        const seg = `<circle cx="20" cy="20" r="${r}" fill="none" stroke="${TYPE_COLORS[label]}" stroke-width="7" stroke-dasharray="${len} ${circumference - len}" stroke-dashoffset="${-offset}" transform="rotate(-90 20 20)"/>`;
        offset += len;
        return seg;
      })
      .join("");

    DOM.typesWrap.innerHTML = `
      <svg width="64" height="64" viewBox="0 0 40 40">${segments}</svg>
      <div class="types-legend">
        ${entries
          .map(
            ([label, count]) => `
          <div class="types-legend-row">
            <span class="types-legend-dot" style="background:${TYPE_COLORS[label]}"></span>
            <span class="lbl">${label}</span>
            <span class="val">${count} (${Math.round((count / total) * 100)}%)</span>
          </div>`,
          )
          .join("")}
      </div>
    `;
  }

  // ========================================
  // DROPDOWNS
  // ========================================
  function closeAllDropdowns() {
    document
      .querySelectorAll(".dd-panel.open")
      .forEach((p) => p.classList.remove("open"));
    document
      .querySelectorAll(".btn-tool.open")
      .forEach((b) => b.classList.remove("open"));
  }

  function toggleDropdown(btn, panel) {
    const isOpen = panel.classList.contains("open");
    closeAllDropdowns();
    if (!isOpen) {
      panel.classList.add("open");
      btn.classList.add("open");
    }
  }

  // ========================================
  // RESET
  // ========================================
  function resetAllFilters() {
    state.searchTerm = "";
    state.activeFilters = {};
    state.page = 1;
    DOM.searchInput.value = "";
    renderFilterPanel();
    applyFiltersAndRender();
  }

  // ========================================
  // THEME
  // ========================================
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    DOM.themeLabel.textContent = theme === "dark" ? "Dark" : "Light";
    try {
      localStorage.setItem("csv-explorer-theme", theme);
    } catch (e) {}
  }

  function initTheme() {
    let theme = "dark";
    try {
      theme = localStorage.getItem("csv-explorer-theme") || "dark";
    } catch (e) {}
    applyTheme(theme);
  }

  // ========================================
  // EVENTS
  // ========================================
  function setupEventListeners() {
    DOM.searchInput.addEventListener("input", function () {
      state.searchTerm = this.value;
      state.page = 1;
      applyFiltersAndRender();
    });

    DOM.csvUpload.addEventListener("change", function () {
      const file = this.files[0];
      if (!file) return;
      loadCSVFile(file);
      this.value = "";
    });

    DOM.clearFiltersBtn.addEventListener("click", resetAllFilters);
    DOM.resetEmptyBtn.addEventListener("click", resetAllFilters);

    DOM.filterBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleDropdown(DOM.filterBtn, DOM.filterPanel);
    });
    DOM.sortBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleDropdown(DOM.sortBtn, DOM.sortPanel);
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".dd-wrap")) closeAllDropdowns();
    });

    DOM.viewSwitch.addEventListener("click", (e) => {
      const btn = e.target.closest(".view-btn");
      if (!btn) return;
      state.view = btn.dataset.view;
      state.page = 1;
      DOM.viewSwitch
        .querySelectorAll(".view-btn")
        .forEach((b) => b.classList.toggle("active", b === btn));
      render();
    });
    DOM.columnsBtn.addEventListener("click", () => {
      DOM.rightPanel.classList.remove("collapsed");
      DOM.rightPanel.scrollIntoView({ block: "start" });
    });

    DOM.columnSearch.addEventListener("input", function () {
      renderColumnsPanel(this.value);
    });

    DOM.resetColumnsBtn.addEventListener("click", () => {
      state.visibleColumns = new Set(state.columnOrder);
      renderColumnsPanel(DOM.columnSearch.value);
      applyFiltersAndRender();
    });

    document.addEventListener(
      "keydown",
      (e) => {
        const isK = e.key.toLowerCase() === "k";
        const isCtrl = e.ctrlKey || e.metaKey;

        if (isCtrl && isK) {
          e.preventDefault();
          e.stopImmediatePropagation();
          DOM.searchInput.focus();
        }
      },
      true,
    );

    DOM.themeToggle.addEventListener("click", () => {
      const current = document.documentElement.getAttribute("data-theme");
      applyTheme(current === "dark" ? "light" : "dark");
    });
  }

  // ========================================
  // INIT
  // ========================================
  function init() {
    initTheme();
    setupEventListeners();
    render();
  }

  init();
})();
