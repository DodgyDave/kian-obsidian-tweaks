const {
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  normalizePath,
} = require("obsidian");

const BODY_CLASS = "kian-tweaks-headings-enabled";
const MODAL_GLITCH_CLASS = "kian-tweaks-modal-glitch-enabled";
const MATRIX_LOCKED_BODY_CLASS = "kian-tweaks-matrix-window-locked";
const ACTIVE_CLASS = "kian-tweaks-matrix-active";
const BLACKOUT_CLASS = "kian-tweaks-matrix-blackout";
const HOST_CLASS = "kian-tweaks-matrix-host";
const CANVAS_CLASS = "kian-tweaks-matrix-canvas";
const WINDOW_CANVAS_CLASS = "kian-tweaks-matrix-window-canvas";
const UNLOCKING_CLASS = "kian-tweaks-matrix-unlocking";
const UNREAD_CLASS = "assistant-edit-notifier-unread";
const BLACKOUT_DELAY_MS = 6000;
const MATRIX_FRAME_INTERVAL_MS = 33;
const UNLOCK_MAX_MS = 400;
const UNLOCK_MIN_MS = 200;
const DEFAULT_SETTINGS = {
  headingsEnabled: true,
  headingFontEnabled: true,
  headingEffectsEnabled: true,
  headingGlowSpeedMs: 180,
  modalGlitchEnabled: true,
  matrixEnabled: true,
  matrixPassword: "matrix",
  matrixTimeoutSeconds: 120,
  notifierEnabled: true,
  watchedFolders: [],
  clearOnOpen: true,
  ignoreDotfiles: true,
  dotColor: "#db29ff",
  dotOpacity: 0.6,
  internalChangeIgnoreWindowMs: 8000,
  changedFiles: [],
  changedFolders: [],
};

module.exports = class KianObsidianTweaksPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.instances = new Map();
    this.changedFiles = new Set(this.settings.changedFiles || []);
    this.changedFolders = new Set(this.settings.changedFolders || []);
    this.internalChangedPaths = new Map();
    this.restoreVaultPatches = [];
    this.activeMatrixInstance = null;
    this.observer = null;
    this.renderTimer = null;
    this.saveTimer = null;
    this.promptOpen = false;
    this.boundHandleUserInput = (event) => this.handleUserInput(event);
    this.boundHandleActivity = () => this.handleActivity();

    this.applyHeadingSettings();
    this.applyModalGlitchSettings();
    this.applyNotifierAppearanceSettings();
    this.patchVaultWriteMethods();
    this.addSettingTab(new KianTweaksSettingTab(this.app, this));

    this.addCommand({
      id: "clear-current-file-notification",
      name: "Clear current file notification",
      callback: () => this.clearActiveFile(),
    });

    this.addCommand({
      id: "clear-all-notifications",
      name: "Clear all notifications",
      callback: () => this.clearAll(),
    });

    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.refreshViews())
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.refreshViews())
    );
    this.registerEvent(
      this.app.workspace.on("file-open", () => this.refreshViews())
    );
    this.registerEvent(
      this.app.metadataCache.on("changed", () => this.refreshViews())
    );

    document.addEventListener("keydown", this.boundHandleUserInput, true);
    document.addEventListener("pointerdown", this.boundHandleUserInput, true);
    document.addEventListener("pointermove", this.boundHandleActivity, true);
    document.addEventListener("wheel", this.boundHandleActivity, true);
    document.addEventListener("scroll", this.boundHandleActivity, true);
    document.addEventListener("touchmove", this.boundHandleActivity, true);
    this.register(() => {
      document.removeEventListener("keydown", this.boundHandleUserInput, true);
      document.removeEventListener(
        "pointerdown",
        this.boundHandleUserInput,
        true
      );
      document.removeEventListener(
        "pointermove",
        this.boundHandleActivity,
        true
      );
      document.removeEventListener("wheel", this.boundHandleActivity, true);
      document.removeEventListener("scroll", this.boundHandleActivity, true);
      document.removeEventListener("touchmove", this.boundHandleActivity, true);
    });

    this.registerInterval(window.setInterval(() => this.refreshViews(), 1000));
    this.app.workspace.onLayoutReady(() => {
      this.registerVaultEvents();
      this.registerExplorerObserver();
      this.refreshViews();
      this.renderDotsSoon();
    });
  }

  onunload() {
    for (const instance of this.instances.values()) {
      instance.destroy();
    }

    this.instances.clear();
    if (this.observer) this.observer.disconnect();
    if (this.renderTimer) window.clearTimeout(this.renderTimer);
    if (this.saveTimer) {
      window.clearTimeout(this.saveTimer);
      this.saveNow();
    }
    for (const restoreVaultPatch of this.restoreVaultPatches.reverse()) {
      restoreVaultPatch();
    }
    this.clearRenderedDots();
    this.clearNotifierAppearanceSettings();
    document.body.classList.remove(BODY_CLASS);
    document.body.classList.remove(MODAL_GLITCH_CLASS);
    document.body.classList.remove(MATRIX_LOCKED_BODY_CLASS);
    document.body.style.removeProperty("--kian-tweaks-heading-glow-speed");
  }

  refreshViews() {
    const activeContentEls = new Set();

    if (!this.settings.matrixEnabled) {
      for (const contentEl of Array.from(this.instances.keys())) {
        this.destroyInstance(contentEl);
      }
      return;
    }

    for (const leaf of this.getFileLeaves()) {
      const view = leaf.view;
      const contentEl = view.contentEl;
      const shouldRun = Boolean(this.viewHasFile(view) && contentEl);
      activeContentEls.add(contentEl);

      if (shouldRun) {
        if (!this.instances.has(contentEl)) {
          this.instances.set(contentEl, new MatrixRain(contentEl, this));
        }
      } else {
        this.destroyInstance(contentEl);
      }
    }

    for (const contentEl of Array.from(this.instances.keys())) {
      if (!activeContentEls.has(contentEl)) {
        this.destroyInstance(contentEl);
      }
    }
  }

  getFileLeaves() {
    const leaves = [];

    if (typeof this.app.workspace.iterateAllLeaves === "function") {
      this.app.workspace.iterateAllLeaves((leaf) => {
        if (leaf.view && this.viewHasFile(leaf.view) && leaf.view.contentEl) {
          leaves.push(leaf);
        }
      });
    } else {
      for (const type of ["markdown", "canvas"]) {
        for (const leaf of this.app.workspace.getLeavesOfType(type)) {
          if (leaf.view && this.viewHasFile(leaf.view) && leaf.view.contentEl) {
            leaves.push(leaf);
          }
        }
      }
    }

    return leaves;
  }

  viewHasFile(view) {
    if (view.file) return true;

    if (typeof view.getState === "function") {
      const state = view.getState();
      return Boolean(state && state.file);
    }

    return false;
  }

  destroyInstance(contentEl) {
    const instance = this.instances.get(contentEl);
    if (!instance) return;

    instance.destroy();
    this.instances.delete(contentEl);
    this.updateMatrixChromeState();
  }

  handleUserInput(event) {
    if (
      event.target &&
      typeof event.target.closest === "function" &&
      event.target.closest(".modal-container, .modal")
    ) {
      return;
    }

    const activeInstances = Array.from(this.instances.values()).filter(
      (instance) => instance.active
    );

    if (activeInstances.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      this.showPasswordPrompt();
      return;
    }

    for (const instance of this.instances.values()) {
      instance.resetIdleTimer();
    }
  }

  handleActivity() {
    const hasActiveInstance = Array.from(this.instances.values()).some(
      (instance) => instance.active
    );

    if (hasActiveInstance) return;

    for (const instance of this.instances.values()) {
      instance.resetIdleTimer();
    }
  }

  hasOpenModal() {
    return Boolean(document.querySelector(".modal-container, .modal"));
  }

  showPasswordPrompt() {
    if (this.promptOpen) return;

    this.promptOpen = true;
    new PasswordModal(
      this.app,
      this.settings.matrixPassword,
      (unlocked) => {
        this.promptOpen = false;

        if (!unlocked) {
          new Notice("Access Denied");
          return;
        }

        for (const instance of this.instances.values()) {
          instance.unlock();
        }
      },
      () => {
        this.promptOpen = false;
      }
    ).open();
  }

  async saveSettings() {
    this.settings.dotOpacity = this.clampOpacity(this.settings.dotOpacity);
    await this.saveNow();
    this.applyHeadingSettings();
    this.applyModalGlitchSettings();
    this.applyNotifierAppearanceSettings();
    this.renderDotsSoon();
    for (const instance of this.instances.values()) {
      instance.resetIdleTimer();
    }
  }

  async loadSettings() {
    const data = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...data,
      watchedFolders: Array.isArray(data.watchedFolders)
        ? data.watchedFolders
        : DEFAULT_SETTINGS.watchedFolders,
      changedFiles: Array.isArray(data.changedFiles)
        ? data.changedFiles
        : DEFAULT_SETTINGS.changedFiles,
      changedFolders: Array.isArray(data.changedFolders)
        ? data.changedFolders
        : DEFAULT_SETTINGS.changedFolders,
      dotOpacity: this.clampOpacity(
        typeof data.dotOpacity === "number"
          ? data.dotOpacity
          : DEFAULT_SETTINGS.dotOpacity
      ),
    };
  }

  async saveNow() {
    this.settings.changedFiles = Array.from(this.changedFiles || []);
    this.settings.changedFolders = Array.from(this.changedFolders || []);
    await this.saveData(this.settings);
  }

  applyHeadingSettings() {
    document.body.classList.toggle(BODY_CLASS, this.settings.headingsEnabled);
    document.body.classList.toggle(
      "kian-tweaks-heading-font-enabled",
      this.settings.headingsEnabled && this.settings.headingFontEnabled
    );
    document.body.classList.toggle(
      "kian-tweaks-heading-effects-enabled",
      this.settings.headingsEnabled && this.settings.headingEffectsEnabled
    );
    document.body.style.setProperty(
      "--kian-tweaks-heading-glow-speed",
      `${Math.max(40, this.settings.headingGlowSpeedMs || 180)}ms`
    );
  }

  applyModalGlitchSettings() {
    document.body.classList.toggle(
      MODAL_GLITCH_CLASS,
      this.settings.modalGlitchEnabled
    );
  }

  collapseSidebars() {
    for (const split of [
      this.app.workspace.leftSplit,
      this.app.workspace.rightSplit,
    ]) {
      if (!split || split.collapsed === true) continue;

      if (typeof split.collapse === "function") {
        split.collapse();
      }
    }
  }

  updateMatrixChromeState() {
    const isLocked = Boolean(
      this.activeMatrixInstance &&
        (this.activeMatrixInstance.active || this.activeMatrixInstance.unlocking)
    );
    document.body.classList.toggle(MATRIX_LOCKED_BODY_CLASS, isLocked);
  }

  activateMatrixInstance(instance) {
    if (
      this.activeMatrixInstance &&
      this.activeMatrixInstance !== instance
    ) {
      this.activeMatrixInstance.deactivate();
    }

    this.activeMatrixInstance = instance;
    this.updateMatrixChromeState();
  }

  clearMatrixInstance(instance) {
    if (this.activeMatrixInstance === instance) {
      this.activeMatrixInstance = null;
    }
    this.updateMatrixChromeState();
  }

  registerVaultEvents() {
    this.registerEvent(
      this.app.vault.on("create", (file) => this.handleChangedFile(file))
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => this.handleChangedFile(file))
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) =>
        this.handleRename(file, oldPath)
      )
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => this.handleDeletedFile(file))
    );
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (
          this.settings.notifierEnabled &&
          this.settings.clearOnOpen &&
          file instanceof TFile
        ) {
          this.clearFile(file.path);
        }
      })
    );
    this.registerEvent(
      this.app.workspace.on("editor-change", (_editor, info) => {
        const file =
          info && info.file instanceof TFile
            ? info.file
            : this.app.workspace.getActiveFile();

        if (file instanceof TFile) {
          this.markInternalChange(file.path);
        }
      })
    );
  }

  patchVaultWriteMethods() {
    this.patchVaultMethod("append", (args) => [this.getFilePath(args[0])]);
    this.patchVaultMethod("create", (args) => [args[0]]);
    this.patchVaultMethod("createBinary", (args) => [args[0]]);
    this.patchVaultMethod("createFolder", (args) => [args[0]]);
    this.patchVaultMethod("modify", (args) => [this.getFilePath(args[0])]);
    this.patchVaultMethod("modifyBinary", (args) => [this.getFilePath(args[0])]);
    this.patchVaultMethod("process", (args) => [this.getFilePath(args[0])]);
    this.patchVaultMethod("rename", (args) => [
      this.getFilePath(args[0]),
      args[1],
    ]);
  }

  patchVaultMethod(methodName, getPaths) {
    const vault = this.app.vault;
    const originalMethod = vault[methodName];
    if (typeof originalMethod !== "function") return;

    const plugin = this;
    vault[methodName] = function (...args) {
      for (const path of getPaths(args)) {
        if (typeof path === "string" && path.length > 0) {
          plugin.markInternalChange(path);
        }
      }

      return originalMethod.apply(this, args);
    };

    this.restoreVaultPatches.push(() => {
      vault[methodName] = originalMethod;
    });
  }

  getFilePath(file) {
    return file && typeof file.path === "string" ? file.path : null;
  }

  registerExplorerObserver() {
    const container = this.app.workspace.containerEl;
    this.observer = new MutationObserver(() => this.renderDotsSoon());
    this.observer.observe(container, {
      childList: true,
      subtree: true,
    });
  }

  applyNotifierAppearanceSettings() {
    document.body.style.setProperty(
      "--assistant-edit-notifier-dot-color",
      this.settings.dotColor
    );
    document.body.style.setProperty(
      "--assistant-edit-notifier-dot-opacity",
      String(this.clampOpacity(this.settings.dotOpacity))
    );
  }

  clearNotifierAppearanceSettings() {
    document.body.style.removeProperty("--assistant-edit-notifier-dot-color");
    document.body.style.removeProperty("--assistant-edit-notifier-dot-opacity");
  }

  clampOpacity(value) {
    if (!Number.isFinite(value)) return DEFAULT_SETTINGS.dotOpacity;
    return Math.min(1, Math.max(0.1, value));
  }

  handleChangedFile(file) {
    if (!this.settings.notifierEnabled) return;
    if (!(file instanceof TFile || file instanceof TFolder)) return;
    if (this.wasRecentlyChangedInsideObsidian(file.path)) return;
    if (!this.shouldWatchPath(file.path)) return;

    if (file instanceof TFile) {
      this.changedFiles.add(file.path);
    } else {
      this.changedFolders.add(file.path);
    }

    this.saveSoon();
    this.renderDotsSoon();
  }

  handleRename(file, oldPath) {
    const wasInternalRename =
      this.wasRecentlyChangedInsideObsidian(oldPath) ||
      this.wasRecentlyChangedInsideObsidian(file.path);

    if (file instanceof TFolder) {
      this.rewriteChangedPathsForFolderRename(oldPath, file.path);
    } else if (this.changedFiles.delete(oldPath) && this.shouldWatchPath(file.path)) {
      this.changedFiles.add(file.path);
    }

    if (this.changedFolders.delete(oldPath) && this.shouldWatchPath(file.path)) {
      this.changedFolders.add(file.path);
    }

    if (!wasInternalRename && this.settings.notifierEnabled && this.shouldWatchPath(file.path)) {
      this.handleChangedFile(file);
      return;
    }

    this.saveSoon();
    this.renderDotsSoon();
  }

  handleDeletedFile(file) {
    this.changedFiles.delete(file.path);
    this.changedFolders.delete(file.path);
    if (file instanceof TFolder) {
      this.removeChangedPathsUnderFolder(file.path);
    }
    this.saveSoon();
    this.renderDotsSoon();
  }

  shouldWatchPath(path) {
    const normalizedPath = normalizePath(path);
    if (this.settings.ignoreDotfiles) {
      const segments = normalizedPath.split("/");
      if (segments.some((segment) => segment.startsWith("."))) return false;
    }
    if (this.settings.watchedFolders.length === 0) return true;
    return this.settings.watchedFolders.some((folder) => {
      const normalizedFolder = normalizePath(folder).replace(/\/$/, "");
      return (
        normalizedPath === normalizedFolder ||
        normalizedPath.startsWith(`${normalizedFolder}/`)
      );
    });
  }

  addParentFolders(path, folders) {
    const parts = normalizePath(path).split("/");
    parts.pop();
    while (parts.length > 0) {
      const folderPath = parts.join("/");
      if (this.shouldWatchPath(folderPath)) folders.add(folderPath);
      parts.pop();
    }
  }

  getUnreadFolders() {
    const folders = new Set(this.changedFolders);
    for (const filePath of this.changedFiles) {
      this.addParentFolders(filePath, folders);
    }
    return folders;
  }

  rewriteChangedPathsForFolderRename(oldPath, newPath) {
    this.changedFiles = this.rewritePathSetForFolderRename(
      this.changedFiles,
      oldPath,
      newPath
    );
    this.changedFolders = this.rewritePathSetForFolderRename(
      this.changedFolders,
      oldPath,
      newPath
    );
  }

  rewritePathSetForFolderRename(paths, oldPath, newPath) {
    const rewritten = new Set();
    const normalizedOldPath = normalizePath(oldPath);
    const normalizedNewPath = normalizePath(newPath);
    for (const path of paths) {
      let nextPath = path;
      if (path === normalizedOldPath) {
        nextPath = normalizedNewPath;
      } else if (path.startsWith(`${normalizedOldPath}/`)) {
        nextPath = `${normalizedNewPath}${path.slice(normalizedOldPath.length)}`;
      }
      if (this.shouldWatchPath(nextPath)) rewritten.add(nextPath);
    }
    return rewritten;
  }

  removeChangedPathsUnderFolder(folderPath) {
    const normalizedFolderPath = normalizePath(folderPath);
    for (const filePath of Array.from(this.changedFiles)) {
      if (
        filePath === normalizedFolderPath ||
        filePath.startsWith(`${normalizedFolderPath}/`)
      ) {
        this.changedFiles.delete(filePath);
      }
    }
    for (const changedFolder of Array.from(this.changedFolders)) {
      if (
        changedFolder === normalizedFolderPath ||
        changedFolder.startsWith(`${normalizedFolderPath}/`)
      ) {
        this.changedFolders.delete(changedFolder);
      }
    }
  }

  clearActiveFile() {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("No active file to clear.");
      return;
    }
    this.clearFile(file.path);
  }

  markInternalChange(path) {
    this.internalChangedPaths.set(normalizePath(path), Date.now());
  }

  wasRecentlyChangedInsideObsidian(path) {
    const normalizedPath = normalizePath(path);
    const changedAt = this.internalChangedPaths.get(normalizedPath);
    if (!changedAt) return false;
    const age = Date.now() - changedAt;
    if (age <= this.settings.internalChangeIgnoreWindowMs) return true;
    this.internalChangedPaths.delete(normalizedPath);
    return false;
  }

  clearFile(path) {
    if (!this.changedFiles.delete(path)) return;
    this.saveSoon();
    this.renderDotsSoon();
  }

  clearAll() {
    this.changedFiles.clear();
    this.changedFolders.clear();
    this.saveSoon();
    this.renderDotsSoon();
    new Notice("Vault edit notifications cleared.");
  }

  renderDotsSoon() {
    if (this.renderTimer) window.clearTimeout(this.renderTimer);
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null;
      this.renderDots();
    }, 50);
  }

  renderDots() {
    const unreadFolders = this.getUnreadFolders();
    const rows = this.app.workspace.containerEl.querySelectorAll(
      ".nav-file-title[data-path], .nav-folder-title[data-path]"
    );
    for (const row of rows) {
      const path = row.getAttribute("data-path");
      const hasUnread =
        this.settings.notifierEnabled &&
        (this.changedFiles.has(path) || unreadFolders.has(path));
      row.classList.toggle(UNREAD_CLASS, hasUnread);
      this.bindClearOnDoubleClick(row, path);
    }
  }

  bindClearOnDoubleClick(row, path) {
    if (!row || row.dataset.assistantEditNotifierBound === "true") return;
    row.dataset.assistantEditNotifierBound = "true";
    row.addEventListener("dblclick", () => {
      const isFolderRow = row.classList.contains("nav-folder-title");
      if (!this.changedFiles.has(path) && !this.changedFolders.has(path)) return;
      if (isFolderRow) {
        this.clearFolderNotification(path);
      } else {
        this.clearFile(path);
      }
    });
  }

  clearFolderNotification(folderPath) {
    const normalizedFolderPath = normalizePath(folderPath);
    let changed = false;
    for (const filePath of Array.from(this.changedFiles)) {
      if (
        filePath === normalizedFolderPath ||
        filePath.startsWith(`${normalizedFolderPath}/`)
      ) {
        this.changedFiles.delete(filePath);
        changed = true;
      }
    }
    for (const changedFolder of Array.from(this.changedFolders)) {
      if (
        changedFolder === normalizedFolderPath ||
        changedFolder.startsWith(`${normalizedFolderPath}/`)
      ) {
        this.changedFolders.delete(changedFolder);
        changed = true;
      }
    }
    if (!changed) return;
    this.saveSoon();
    this.renderDotsSoon();
  }

  clearRenderedDots() {
    const rows = this.app.workspace.containerEl.querySelectorAll(`.${UNREAD_CLASS}`);
    for (const row of rows) row.classList.remove(UNREAD_CLASS);
  }

  saveSoon() {
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, 250);
  }

};

class KianTweaksSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Heading Tweaks" });

    new Setting(containerEl)
      .setName("Enable heading tweaks")
      .setDesc("Enable Kian's custom heading styling and retro effects.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.headingsEnabled)
          .onChange(async (value) => {
            this.plugin.settings.headingsEnabled = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Heading font")
      .setDesc("Use Obsidian's text font for headings.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.headingFontEnabled)
          .onChange(async (value) => {
            this.plugin.settings.headingFontEnabled = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Retro heading effects")
      .setDesc("Enable heading glow, H1 block cursor, H1 chroma offset, and H2 terminal suffix.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.headingEffectsEnabled)
          .onChange(async (value) => {
            this.plugin.settings.headingEffectsEnabled = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Heading pulse speed")
      .setDesc("Milliseconds per glow pulse.")
      .addSlider((slider) => {
        slider
          .setLimits(80, 800, 10)
          .setValue(this.plugin.settings.headingGlowSpeedMs)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.headingGlowSpeedMs = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Modal glitch")
      .setDesc("Glitch-shake modals, command pickers, and QuickAdd prompts when they open.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.modalGlitchEnabled)
          .onChange(async (value) => {
            this.plugin.settings.modalGlitchEnabled = value;
            await this.plugin.saveSettings();
          });
      });

    containerEl.createEl("h2", { text: "Matrix Lock Screen" });

    new Setting(containerEl)
      .setName("Enable Matrix lock")
      .setDesc("Lock file-backed views with the Matrix corruption animation after inactivity.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.matrixEnabled)
          .onChange(async (value) => {
            this.plugin.settings.matrixEnabled = value;
            await this.plugin.saveSettings();
            this.plugin.refreshViews();
          });
      });

    new Setting(containerEl)
      .setName("Timeout")
      .setDesc("Seconds of inactivity before the Matrix lock starts.")
      .addText((text) => {
        text.inputEl.type = "number";
        text
          .setPlaceholder("5")
          .setValue(String(this.plugin.settings.matrixTimeoutSeconds))
          .onChange(async (value) => {
            const parsed = Number.parseFloat(value);
            this.plugin.settings.matrixTimeoutSeconds =
              Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Password")
      .setDesc("Passcode required to unlock the visual lock. This is not encryption or real vault security.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("matrix")
          .setValue(this.plugin.settings.matrixPassword)
          .onChange(async (value) => {
            this.plugin.settings.matrixPassword = value;
            await this.plugin.saveSettings();
          });
      });

    containerEl.createEl("h2", { text: "Vault Edit Notifications" });

    new Setting(containerEl)
      .setName("Enable notifications")
      .setDesc("Show dots in the file explorer for files changed outside Obsidian.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.notifierEnabled)
          .onChange(async (value) => {
            this.plugin.settings.notifierEnabled = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Watched folders")
      .setDesc("Comma-separated vault-relative folders. Leave empty to watch the whole vault.")
      .addTextArea((text) => {
        text
          .setPlaceholder("Leave empty for whole vault")
          .setValue(this.plugin.settings.watchedFolders.join(", "))
          .onChange(async (value) => {
            this.plugin.settings.watchedFolders = value
              .split(",")
              .map((folder) => normalizePath(folder.trim()))
              .filter(Boolean);
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Clear when opened")
      .setDesc("Remove a file notification after opening the file.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.clearOnOpen)
          .onChange(async (value) => {
            this.plugin.settings.clearOnOpen = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Ignore dotfiles")
      .setDesc("Ignore hidden files and folders such as .obsidian.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.ignoreDotfiles)
          .onChange(async (value) => {
            this.plugin.settings.ignoreDotfiles = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Dot color")
      .setDesc("Color used for file and folder notification dots.")
      .addColorPicker((colorPicker) => {
        colorPicker
          .setValue(this.plugin.settings.dotColor)
          .onChange(async (value) => {
            this.plugin.settings.dotColor = value;
            await this.plugin.saveSettings();
          });
      });

    const opacitySetting = new Setting(containerEl)
      .setName("Dot opacity")
      .setDesc("Lower values make the dot more transparent.")
      .addSlider((slider) => {
        slider
          .setLimits(10, 100, 1)
          .setValue(Math.round(this.plugin.settings.dotOpacity * 100))
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.dotOpacity = value / 100;
            await this.plugin.saveSettings();
          });
      });
    opacitySetting.settingEl.addClass("assistant-edit-notifier-opacity-setting");
  }
}

class PasswordModal extends Modal {
  constructor(app, password, onSubmit, onDismiss) {
    super(app);
    this.password = password;
    this.submitted = false;
    this.onDismiss = onDismiss;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("kian-tweaks-matrix-unlock-modal");
    contentEl.createEl("h2", { text: "VAULT LOCKED" });
    contentEl.createEl("p", {
      text: "Access requires operator authentication.",
    });

    const input = contentEl.createEl("input", {
      attr: {
        autofocus: true,
        placeholder: "Enter passcode",
        type: "password",
      },
    });
    input.addClass("kian-tweaks-matrix-password-input");

    const submit = () => {
      const expected = this.password || "";
      const unlocked = input.value === expected;
      this.submitted = true;
      this.close();
      this.onSubmit(unlocked);
    };

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submit();
      }
    });

    new Setting(contentEl).addButton((button) =>
      button.setButtonText("Unlock").setCta().onClick(submit)
    );

    window.setTimeout(() => input.focus(), 0);
  }

  onClose() {
    this.contentEl.removeClass("kian-tweaks-matrix-unlock-modal");
    this.contentEl.empty();

    if (!this.submitted) {
      this.onDismiss();
    }
  }
}

class MatrixRain {
  constructor(hostEl, plugin) {
    this.hostEl = hostEl;
    this.plugin = plugin;
    this.canvas = hostEl.createEl("canvas", { cls: CANVAS_CLASS });
    this.context = this.canvas.getContext("2d");
    this.primaryGlyphs =
      "01ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%&*+-/=<>[]{}";
    this.kanaGlyphs =
      "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン";
    this.kanjiGlyphs = "零壱弐参肆伍陸漆捌玖日月火水木金土空電光影夢無有心門鍵暗雨終始解";
    this.fontSize = 16;
    this.fontFamily = "monospace";
    this.columnWidth = 10;
    this.rowHeight = 19;
    this.gridX = 0;
    this.gridY = 0;
    this.corruptedCells = new Map();
    this.maxTrails = 520;
    this.trails = [];
    this.active = false;
    this.canvasInBody = false;
    this.blackoutTimer = 0;
    this.idleTimer = 0;
    this.unlocking = false;
    this.unlockColumns = new Map();
    this.unlockStartedAt = 0;
    this.unlockTimer = 0;
    this.lastFrame = performance.now();
    this.lastDrawAt = 0;
    this.animationFrame = 0;
    this.resizeObserver = new ResizeObserver(() => this.resize());

    this.hostEl.addClass(HOST_CLASS);
    this.resizeObserver.observe(this.hostEl);
    this.resize();
    this.draw = this.draw.bind(this);
    this.resetIdleTimer();
  }

  resetIdleTimer() {
    window.clearTimeout(this.idleTimer);

    if (this.active || this.unlocking) return;

    const timeout = Math.max(
      0.5,
      this.plugin.settings.matrixTimeoutSeconds || 5
    );
    this.idleTimer = window.setTimeout(() => this.activate(), timeout * 1000);
  }

  activate() {
    if (this.active || this.unlocking) return;

    if (this.plugin.hasOpenModal()) {
      this.resetIdleTimer();
      return;
    }

    this.plugin.collapseSidebars();
    this.active = true;
    this.plugin.activateMatrixInstance(this);
    this.moveCanvasToBody();
    this.resetAnimationState();
    this.hostEl.addClass(ACTIVE_CLASS);
    this.canvas.addClass(ACTIVE_CLASS);
    this.blackoutTimer = window.setTimeout(() => {
      if (this.active) {
        this.hostEl.addClass(BLACKOUT_CLASS);
        this.canvas.addClass(BLACKOUT_CLASS);
      }
    }, BLACKOUT_DELAY_MS);
    this.resize();
    this.startDrawing();
  }

  deactivate() {
    if (!this.active) return;

    this.active = false;
    this.unlocking = false;
    window.clearTimeout(this.blackoutTimer);
    window.clearTimeout(this.unlockTimer);
    this.corruptedCells.clear();
    this.trails = [];
    this.hostEl.removeClass(ACTIVE_CLASS);
    this.hostEl.removeClass(BLACKOUT_CLASS);
    this.hostEl.removeClass(UNLOCKING_CLASS);
    this.canvas.removeClass(ACTIVE_CLASS);
    this.canvas.removeClass(BLACKOUT_CLASS);
    this.canvas.removeClass(UNLOCKING_CLASS);
    this.context.clearRect(0, 0, this.width, this.height);
    this.stopDrawing();
    this.moveCanvasToHost();
    this.plugin.clearMatrixInstance(this);
  }

  unlock() {
    if (!this.active) {
      this.resetIdleTimer();
      return;
    }

    this.active = false;
    this.unlocking = true;
    this.unlockStartedAt = performance.now();
    this.prepareUnlockColumns();
    window.clearTimeout(this.blackoutTimer);
    window.clearTimeout(this.unlockTimer);
    this.hostEl.addClass(UNLOCKING_CLASS);
    this.hostEl.removeClass(ACTIVE_CLASS);
    this.hostEl.removeClass(BLACKOUT_CLASS);
    this.canvas.addClass(UNLOCKING_CLASS);
    this.canvas.removeClass(ACTIVE_CLASS);
    this.canvas.removeClass(BLACKOUT_CLASS);
    this.moveCanvasToBody();
    this.plugin.updateMatrixChromeState();
    this.startDrawing();

    this.unlockTimer = window.setTimeout(() => {
      this.finishUnlock();
    }, UNLOCK_MAX_MS);
  }

  finishUnlock() {
    if (!this.unlocking) return;

    this.unlocking = false;
    this.unlockColumns.clear();
    window.clearTimeout(this.unlockTimer);
    this.corruptedCells.clear();
    this.trails = [];
    this.hostEl.removeClass(UNLOCKING_CLASS);
    this.canvas.removeClass(UNLOCKING_CLASS);
    this.context.clearRect(0, 0, this.width, this.height);
    this.stopDrawing();
    this.moveCanvasToHost();
    this.plugin.clearMatrixInstance(this);
    this.resetIdleTimer();
  }

  moveCanvasToBody() {
    if (this.canvasInBody) return;

    this.canvas.addClass(WINDOW_CANVAS_CLASS);
    document.body.appendChild(this.canvas);
    this.canvasInBody = true;
  }

  moveCanvasToHost() {
    if (!this.canvasInBody) return;

    this.canvas.removeClass(WINDOW_CANVAS_CLASS);
    this.hostEl.appendChild(this.canvas);
    this.canvasInBody = false;
  }

  startDrawing() {
    if (this.animationFrame) return;

    this.lastFrame = performance.now();
    this.lastDrawAt = 0;
    this.animationFrame = requestAnimationFrame(this.draw);
  }

  stopDrawing() {
    if (!this.animationFrame) return;

    cancelAnimationFrame(this.animationFrame);
    this.animationFrame = 0;
  }

  resize() {
    const rect =
      this.active || this.unlocking
        ? { width: window.innerWidth, height: window.innerHeight }
        : this.hostEl.getBoundingClientRect();
    const pixelRatio = window.devicePixelRatio || 1;
    this.width = Math.max(1, Math.floor(rect.width));
    this.height = Math.max(1, Math.floor(rect.height));
    this.canvas.width = Math.floor(this.width * pixelRatio);
    this.canvas.height = Math.floor(this.height * pixelRatio);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    if (this.active || this.unlocking) {
      this.syncGridToViewport();
    } else {
      this.syncGridToPage();
    }
    this.pruneCorruptedCells();

    this.resetDrops();
  }

  syncGridToViewport() {
    const textEl =
      this.hostEl.querySelector(".cm-content") ||
      this.hostEl.querySelector(".markdown-preview-sizer") ||
      this.hostEl.querySelector(".canvas-wrapper") ||
      this.hostEl;
    const style = window.getComputedStyle(textEl);
    const parsedFontSize = Number.parseFloat(style.fontSize);
    const parsedLineHeight = Number.parseFloat(style.lineHeight);
    this.fontSize = Number.isFinite(parsedFontSize) ? parsedFontSize : 16;
    this.fontFamily = style.fontFamily || "monospace";
    this.context.font = `${this.fontSize}px ${this.fontFamily}`;
    this.columnWidth = Math.max(6, this.context.measureText("0").width);
    this.rowHeight = Math.max(
      this.fontSize * 1.1,
      Number.isFinite(parsedLineHeight) ? parsedLineHeight : this.fontSize * 1.25
    );
    this.gridX = 0;
    this.gridY = 0;
  }

  syncGridToPage() {
    const textEl =
      this.hostEl.querySelector(".cm-content") ||
      this.hostEl.querySelector(".markdown-preview-sizer") ||
      this.hostEl.querySelector(".canvas-wrapper") ||
      this.hostEl;
    const hostRect = this.hostEl.getBoundingClientRect();
    const textRect = textEl.getBoundingClientRect();
    const style = window.getComputedStyle(textEl);
    const parsedFontSize = Number.parseFloat(style.fontSize);
    const parsedLineHeight = Number.parseFloat(style.lineHeight);
    const fontSize = Number.isFinite(parsedFontSize) ? parsedFontSize : 16;
    const fontFamily =
      style.fontFamily || "monospace";

    this.fontSize = fontSize;
    this.fontFamily = fontFamily;
    this.context.font = `${this.fontSize}px ${this.fontFamily}`;
    this.columnWidth = Math.max(6, this.context.measureText("0").width);
    this.rowHeight = Math.max(
      this.fontSize * 1.1,
      Number.isFinite(parsedLineHeight) ? parsedLineHeight : this.fontSize * 1.25
    );
    const textOffsetX = Math.max(0, textRect.left - hostRect.left);
    const textOffsetY = Math.max(0, textRect.top - hostRect.top);
    this.gridX =
      textOffsetX - Math.ceil(textOffsetX / this.columnWidth) * this.columnWidth;
    this.gridY =
      textOffsetY - Math.ceil(textOffsetY / this.rowHeight) * this.rowHeight;
  }

  resetAnimationState() {
    this.corruptedCells.clear();
    this.trails = [];
    this.unlockColumns.clear();
    this.lastFrame = performance.now();
    this.hostEl.removeClass(BLACKOUT_CLASS);
    this.hostEl.removeClass(UNLOCKING_CLASS);
    this.canvas.removeClass(BLACKOUT_CLASS);
    this.canvas.removeClass(UNLOCKING_CLASS);
    window.clearTimeout(this.blackoutTimer);
    window.clearTimeout(this.unlockTimer);
    this.context.clearRect(0, 0, this.width, this.height);
    this.resetDrops();
  }

  resetDrops() {
    const count = Math.max(
      1,
      Math.ceil((this.width - this.gridX) / this.columnWidth) + 2
    );
    this.drops = Array.from({ length: count }, (_, column) =>
      this.createDrop(column)
    );
  }

  createDrop(column) {
    const tailLength = 7 + Math.floor(Math.random() * 15);
    const startY = this.gridY - this.rowHeight * (tailLength + 2);

    return {
      column,
      delay: Math.random() * 2200,
      glyph: this.randomGlyph(),
      nextTrailY: this.gridY,
      speed: 70 + Math.random() * 260,
      switchAfter: 40 + Math.random() * 180,
      switchTime: 0,
      tail: Array.from({ length: tailLength }, () => ({
        glyph: this.randomGlyph(),
        switchAfter: 80 + Math.random() * 520,
        switchTime: Math.random() * 220,
      })),
      trailEvery: this.rowHeight * (0.65 + Math.random() * 0.55),
      x: this.gridX + column * this.columnWidth,
      y: startY,
    };
  }

  draw(now) {
    if (
      this.lastDrawAt &&
      now - this.lastDrawAt < MATRIX_FRAME_INTERVAL_MS
    ) {
      this.animationFrame = requestAnimationFrame(this.draw);
      return;
    }

    const delta = Math.min(64, now - this.lastFrame);
    this.lastFrame = now;
    this.lastDrawAt = now;

    if (!this.active) {
      if (this.unlocking) {
        this.drawUnlock(now);
      }

      if (this.active || this.unlocking) {
        this.animationFrame = requestAnimationFrame(this.draw);
      } else {
        this.animationFrame = 0;
      }
      return;
    }

    this.context.clearRect(0, 0, this.width, this.height);
    this.context.font = `${this.fontSize}px ${this.fontFamily}`;
    this.context.textBaseline = "top";

    this.drawCorruptionMask();
    this.drawTrails(delta);

    for (const drop of this.drops) {
      if (drop.delay > 0) {
        drop.delay -= delta;
        continue;
      }

      drop.y += (drop.speed * delta) / 1000;
      drop.switchTime += delta;

      if (drop.switchTime >= drop.switchAfter) {
        drop.glyph = this.randomGlyph();
        drop.switchTime = 0;
        drop.switchAfter = 35 + Math.random() * 160;
      }

      this.updateTail(drop, delta);

      if (drop.y >= drop.nextTrailY) {
        this.addTrail(drop);
        drop.nextTrailY = drop.y + drop.trailEvery;
        drop.trailEvery = this.rowHeight * (0.65 + Math.random() * 0.55);
      }

      this.drawTail(drop);

      this.drawEncodedCell(drop.glyph, drop.x, this.snapY(drop.y), {
        backgroundOpacity: 0.92,
        glowOpacity: 0.62,
        glyphOpacity: 0.92,
        highlightOpacity: 0.82,
      });

      if (drop.y > this.height + this.rowHeight) {
        const next = this.createDrop(drop.column);
        next.delay = Math.random() * 900;
        Object.assign(drop, next);
      }
    }

    if (this.active || this.unlocking) {
      this.animationFrame = requestAnimationFrame(this.draw);
    } else {
      this.animationFrame = 0;
    }
  }

  randomGlyph() {
    const roll = Math.random();
    const glyphs =
      roll < 0.72
        ? this.primaryGlyphs
        : roll < 0.94
          ? this.kanaGlyphs
          : this.kanjiGlyphs;

    return glyphs[Math.floor(Math.random() * glyphs.length)];
  }

  snapY(y) {
    return (
      this.gridY +
      Math.floor((y - this.gridY) / this.rowHeight) * this.rowHeight
    );
  }

  drawUnlock(now) {
    const elapsed = now - this.unlockStartedAt;
    const visibleCells = Array.from(this.corruptedCells.values());

    this.context.clearRect(0, 0, this.width, this.height);
    this.context.font = `${this.fontSize}px ${this.fontFamily}`;
    this.context.textBaseline = "top";

    for (const cell of visibleCells) {
      const columnTiming = this.unlockColumns.get(cell.column) || {
        duration: UNLOCK_MAX_MS,
      };
      const progress = Math.min(1, elapsed / columnTiming.duration);
      if (progress >= 1) continue;

      const fade =
        progress < 0.72 ? 1 : Math.max(0, 1 - (progress - 0.72) / 0.28);

      this.context.shadowBlur = 0;
      this.context.fillStyle = `rgba(0, 0, 0, ${fade})`;
      this.context.fillRect(
        cell.x - 1,
        cell.y - 1,
        this.columnWidth + 2,
        this.rowHeight
      );

      if (Math.random() > 0.12) {
        this.context.shadowColor = `rgba(92, 255, 137, ${0.45 * fade})`;
        this.context.shadowBlur = 5;
        this.context.fillStyle = `rgba(92, 255, 137, ${(0.85 - progress * 0.35) * fade})`;
        this.context.fillText(this.randomGlyph(), cell.x, cell.y);
      }
    }

    if (elapsed >= UNLOCK_MAX_MS) {
      this.finishUnlock();
    }
  }

  prepareUnlockColumns() {
    this.unlockColumns.clear();

    for (const cell of this.corruptedCells.values()) {
      if (this.unlockColumns.has(cell.column)) continue;

      this.unlockColumns.set(cell.column, {
        duration: UNLOCK_MIN_MS + Math.random() * (UNLOCK_MAX_MS - UNLOCK_MIN_MS),
      });
    }
  }

  updateTail(drop, delta) {
    for (const segment of drop.tail) {
      segment.switchTime += delta;

      if (segment.switchTime >= segment.switchAfter) {
        segment.glyph = this.randomGlyph();
        segment.switchTime = 0;
        segment.switchAfter = 80 + Math.random() * 520;
      }
    }
  }

  drawTail(drop) {
    for (let index = drop.tail.length - 1; index >= 0; index -= 1) {
      const segment = drop.tail[index];
      const y = this.snapY(drop.y) - this.rowHeight * (index + 1);
      if (y < -this.rowHeight || y > this.height + this.rowHeight) continue;

      const progress = 1 - index / drop.tail.length;
      const opacity = 0.08 + progress * 0.54;
      const blur = 1 + progress * 6;

      this.drawEncodedCell(segment.glyph, drop.x, y, {
        backgroundOpacity: 0.18 + progress * 0.62,
        glowBlur: blur,
        glowOpacity: opacity * 0.55,
        glyphOpacity: opacity,
      });
    }

    this.context.shadowBlur = 0;
  }

  addTrail(drop) {
    const visibleTail = drop.tail.filter(
      (_, index) => Math.random() > index / drop.tail.length
    );
    const segment =
      visibleTail[Math.floor(Math.random() * visibleTail.length)] || drop.tail[0];
    const index = Math.max(0, drop.tail.indexOf(segment));

    this.trails.push({
      age: 0,
      glyph: Math.random() > 0.35 ? segment.glyph : this.randomGlyph(),
      life: 2600 + Math.random() * 5200,
      size: this.fontSize,
      x: drop.x,
      y: this.snapY(drop.y) - this.rowHeight * (index + 1),
    });

    if (this.trails.length > this.maxTrails) {
      this.trails.splice(0, this.trails.length - this.maxTrails);
    }
  }

  drawTrails(delta) {
    const liveTrails = [];

    for (const trail of this.trails) {
      trail.age += delta;
      if (trail.age >= trail.life) continue;

      const remaining = 1 - trail.age / trail.life;
      const opacity = Math.pow(remaining, 1.45) * 0.5;
      const blur = 2 + remaining * 5;

      this.context.font = `${trail.size}px ${this.fontFamily}`;
      this.drawEncodedCell(trail.glyph, trail.x, trail.y, {
        backgroundOpacity: opacity * 0.78,
        glowBlur: blur,
        glowOpacity: opacity * 0.6,
        glyphOpacity: opacity,
        size: trail.size,
      });

      liveTrails.push(trail);
    }

    this.trails = liveTrails;
    this.context.shadowBlur = 0;
    this.context.font = `${this.fontSize}px ${this.fontFamily}`;
  }

  drawEncodedCell(glyph, x, y, options = {}) {
    const size = options.size || this.fontSize;
    const backgroundOpacity = options.backgroundOpacity || 0.45;
    const glyphOpacity = options.glyphOpacity || 0.6;
    const glowBlur = options.glowBlur || 7;
    const glowOpacity = options.glowOpacity || 0.4;
    const highlightOpacity = options.highlightOpacity || 0;
    const cellWidth = this.columnWidth;
    const cellHeight = this.rowHeight;
    const cellX = x - this.columnWidth * 0.08;
    const cellY = y - this.rowHeight * 0.08;

    this.markCorruptedCell(cellX, cellY, cellWidth, cellHeight);

    this.context.shadowBlur = 0;
    this.context.fillStyle = "#000";
    this.context.fillRect(cellX, cellY, cellWidth, cellHeight);

    this.context.shadowColor = `rgba(92, 255, 137, ${glowOpacity})`;
    this.context.shadowBlur = glowBlur;
    this.context.fillStyle = `rgba(92, 255, 137, ${glyphOpacity})`;
    this.context.fillText(glyph, x, y);

    if (highlightOpacity > 0) {
      this.context.shadowBlur = 0;
      this.context.fillStyle = `rgba(210, 255, 221, ${highlightOpacity})`;
      this.context.fillText(glyph, x, y);
    }
  }

  markCorruptedCell(x, y, width, height) {
    if (
      x > this.width ||
      y > this.height ||
      x + width < 0 ||
      y + height < 0
    ) {
      return;
    }

    const column = Math.floor((x - this.gridX) / this.columnWidth);
    const row = Math.floor((y - this.gridY) / this.rowHeight);
    const key = `${column}:${row}`;
    this.corruptedCells.set(key, {
      column,
      row,
      x: this.gridX + column * this.columnWidth,
      y: this.gridY + row * this.rowHeight,
    });
  }

  drawCorruptionMask() {
    this.context.shadowBlur = 0;

    for (const cell of this.corruptedCells.values()) {
      this.context.fillStyle = "#000";
      this.context.fillRect(
        cell.x - 1,
        cell.y - 1,
        this.columnWidth + 2,
        this.rowHeight
      );
    }
  }

  pruneCorruptedCells() {
    for (const [key, cell] of this.corruptedCells.entries()) {
      if (cell.x > this.width || cell.y > this.height) {
        this.corruptedCells.delete(key);
      }
    }
  }

  destroy() {
    this.active = false;
    this.unlocking = false;
    window.clearTimeout(this.blackoutTimer);
    window.clearTimeout(this.idleTimer);
    window.clearTimeout(this.unlockTimer);
    this.stopDrawing();
    this.resizeObserver.disconnect();
    if (this.canvasInBody) {
      this.canvas.removeClass(WINDOW_CANVAS_CLASS);
      this.canvasInBody = false;
    }
    this.canvas.remove();
    this.hostEl.removeClass(HOST_CLASS);
    this.hostEl.removeClass(ACTIVE_CLASS);
    this.hostEl.removeClass(BLACKOUT_CLASS);
    this.hostEl.removeClass(UNLOCKING_CLASS);
    this.canvas.removeClass(ACTIVE_CLASS);
    this.canvas.removeClass(BLACKOUT_CLASS);
    this.canvas.removeClass(UNLOCKING_CLASS);
    this.unlockColumns.clear();
    this.plugin.clearMatrixInstance(this);
  }
}
