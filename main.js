/*
  Writing Annotations — Obsidian Plugin v3

  Storage: annotations live in the note's YAML frontmatter.
  Visual:  annotated text is wrapped in ==highlights== (native Obsidian).
           Reading view shows a tap-able popup with the comment.

  Example frontmatter:
    annotations:
      - text: "Hanging with Colton was cool."
        note: "Make this punchier — lead with the insight."
        created: "2026-03-08"
*/

const {
  Plugin, Modal, ItemView, MarkdownView,
  Notice, Platform, TFile, addIcon
} = require('obsidian');

addIcon('wa-icon', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`);

const VIEW_TYPE = 'writing-annotations-panel';

// ─────────────────────────────────────────────
// Frontmatter helpers
// ─────────────────────────────────────────────

async function getAnnotations(app, file) {
  const cache = app.metadataCache.getFileCache(file);
  const anns  = cache?.frontmatter?.annotations;
  return Array.isArray(anns) ? anns : [];
}

async function addAnnotation(app, file, text, note) {
  await app.fileManager.processFrontMatter(file, (fm) => {
    if (!Array.isArray(fm.annotations)) fm.annotations = [];
    fm.annotations.push({
      text,
      note,
      created: new Date().toISOString().split('T')[0]
    });
  });
}

async function updateAnnotation(app, file, text, newNote) {
  await app.fileManager.processFrontMatter(file, (fm) => {
    if (!Array.isArray(fm.annotations)) return;
    const ann = fm.annotations.find(a => a.text === text);
    if (ann) ann.note = newNote;
  });
}

async function removeAnnotation(app, file, text) {
  await app.fileManager.processFrontMatter(file, (fm) => {
    if (!Array.isArray(fm.annotations)) return;
    fm.annotations = fm.annotations.filter(a => a.text !== text);
    if (fm.annotations.length === 0) delete fm.annotations;
  });
}

// Atomic resolve: read raw file, strip ==marks== from body, write back,
// then remove from frontmatter. Two awaited steps = no race condition.
async function atomicRemove(app, file, annText) {
  const target = `==${annText}==`;
  let raw = await app.vault.read(file);

  // Only modify body if the highlight still exists
  if (raw.includes(target)) {
    raw = raw.replace(target, annText);
    await app.vault.modify(file, raw);
    // vault.modify fully completes before we proceed
  }

  // Now processFrontMatter reads the already-updated file — no conflict
  await removeAnnotation(app, file, annText);
}

function buildSingleExport(ann) {
  return `"${ann.text}"\n\nEdit needed: ${ann.note}`;
}

// Returns a single-line anchor from any selection (max 120 chars).
// Used for ==highlight== wrapping and frontmatter key — both require single-line text.
function textAnchor(text) {
  const firstLine = text.split('\n').map(l => l.trim()).find(l => l.length > 0) || text.trim();
  return firstLine.length > 120 ? firstLine.slice(0, 120).trimEnd() + '…' : firstLine;
}

function buildLLMExport(filename, annotations) {
  const lines = [
    `# Writing Annotations — ${filename}`,
    `_${annotations.length} edit request${annotations.length !== 1 ? 's' : ''}_`,
    ''
  ];
  annotations.forEach((a, i) => {
    lines.push(`## [${i + 1}]`);
    lines.push(`**Text:** "${a.text}"`);
    lines.push(`**Edit needed:** ${a.note}`);
    if (a.created) lines.push(`**Date:** ${a.created}`);
    lines.push('');
  });
  lines.push('---');
  lines.push('Please apply all edits above and return the revised passage.');
  return lines.join('\n');
}

// ─────────────────────────────────────────────
// Annotation input modal
// ─────────────────────────────────────────────

class AnnotationInputModal extends Modal {
  constructor(app, selectedText, onSubmit, initialValue = '', onResolve = null) {
    super(app);
    this.selectedText = selectedText;
    this.onSubmit     = onSubmit;
    this.initialValue = initialValue;
    this.onResolve    = onResolve;
  }

  onOpen() {
    try {
      const { contentEl, modalEl } = this;

      if (Platform.isMobile) {
        modalEl.addClass('wa-mobile-modal');
        // Center vertically, nudged above midpoint so keyboard doesn't obscure
        const container = modalEl.parentElement;
        if (container) {
          container.style.alignItems    = 'center';
          container.style.paddingBottom = '22vh';
        }
        modalEl.style.width        = '92%';
        modalEl.style.maxWidth     = '440px';
        modalEl.style.borderRadius = '18px';
        modalEl.style.margin       = '0';
        modalEl.style.boxShadow    = '0 12px 48px rgba(0,0,0,0.55)';
      }

      contentEl.addClass('wa-modal-content');
      // Flex column so button row is always pinned at bottom
      Object.assign(contentEl.style, {
        display:       'flex',
        flexDirection: 'column',
        maxHeight:     Platform.isMobile ? '72vh' : '80vh',
        overflow:      'hidden'
      });

      const isEditing = !!this.initialValue;
      contentEl.createEl('div', { cls: 'wa-modal-title', text: isEditing ? 'Edit Annotation' : 'Annotation' });

      // Scrollable body — preview + textarea scroll freely, buttons stay fixed
      const scrollBody = contentEl.createEl('div');
      Object.assign(scrollBody.style, {
        overflowY: 'auto',
        flex:      '1',
        minHeight: '0'
      });

      const preview = scrollBody.createEl('div', { cls: 'wa-quoted-preview' });
      // Show truncated preview so it never dominates the modal
      const previewText = this.selectedText.length > 220
        ? this.selectedText.slice(0, 220).trimEnd() + `… (${this.selectedText.length} chars selected)`
        : this.selectedText;
      preview.setText(`"${previewText}"`);

      const textarea = scrollBody.createEl('textarea', {
        cls:  'wa-comment-input',
        attr: { placeholder: 'What needs to change, stand out, or get done?', rows: '3' }
      });
      textarea.value = this.initialValue;

      textarea.addEventListener('input', () => {
        textarea.style.height = 'auto';
        textarea.style.height = `${Math.min(textarea.scrollHeight, 280)}px`;
      });

      const submit = () => {
        const val = textarea.value.trim();
        if (!val) {
          textarea.classList.add('wa-shake');
          setTimeout(() => textarea.classList.remove('wa-shake'), 400);
          textarea.focus();
          return;
        }
        saveBtn.setText('✓ Saved');
        saveBtn.disabled = true;
        setTimeout(() => { this.close(); this.onSubmit(val); }, 180);
      };

      // Button row pinned outside scroll body — always visible
      let saveBtn;
      if (isEditing && this.onResolve) {
        const btnRow = contentEl.createEl('div', { cls: 'wa-btn-row' });
        btnRow.style.flexShrink = '0';
        saveBtn = btnRow.createEl('button', { cls: 'wa-submit-btn', text: 'Save' });
        const resolveBtn = btnRow.createEl('button', { cls: 'wa-resolve-btn', text: 'Resolve ✓' });
        resolveBtn.addEventListener('click', () => {
          this.close();
          this.onResolve();
        });
      } else {
        const btnRow = contentEl.createEl('div', { cls: 'wa-btn-row' });
        btnRow.style.flexShrink = '0';
        saveBtn = btnRow.createEl('button', { cls: 'wa-submit-btn', text: 'Save' });
      }

      if (!Platform.isMobile) {
        const hint = contentEl.createEl('div', { cls: 'wa-hint', text: 'Ctrl/Cmd+Enter to save' });
        hint.style.flexShrink = '0';
      }

      saveBtn.addEventListener('click', submit);
      textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit();
      });

      requestAnimationFrame(() => textarea.focus());
    } catch (err) {
      console.error('[WritingAnnotations] AnnotationInputModal.onOpen failed:', err);
      this.contentEl.createEl('p', { text: `Error opening modal: ${err.message}` });
    }
  }

  onClose() { this.contentEl.empty(); }
}

// ─────────────────────────────────────────────
// Modal: annotation list (mobile full-sheet)
// ─────────────────────────────────────────────

class AnnotationListModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  async onOpen() {
    if (Platform.isMobile) {
      Object.assign(this.modalEl.style, {
        position:     'fixed',
        bottom:       '0',
        left:         '0',
        right:        '0',
        top:          'auto',
        width:        '100%',
        maxWidth:     '100%',
        borderRadius: '16px 16px 0 0',
        margin:       '0',
        maxHeight:    '80vh',
        overflowY:    'auto'
      });
    }

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      this.contentEl.createEl('p', { text: 'Open a note first.' });
      return;
    }

    await this.plugin.renderAnnotationList(this.contentEl, view, () => this.close());
  }

  onClose() { this.contentEl.empty(); }
}

// ─────────────────────────────────────────────
// Sidebar panel (desktop)
// ─────────────────────────────────────────────

class AnnotationPanelView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType()    { return VIEW_TYPE; }
  getDisplayText() { return 'Annotations'; }
  getIcon()        { return 'wa-icon'; }

  async onOpen() {
    await this.refresh();
    // Refresh when switching notes
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.refresh()));
    // Refresh when frontmatter changes
    this.registerEvent(this.app.metadataCache.on('changed', () => this.refresh()));
    // Refresh when file body changes (catches manual == deletion)
    this.registerEvent(this.app.vault.on('modify', (file) => {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (view?.file === file) this.refresh();
    }));
  }

  async refresh() {
    const wrap  = this.containerEl.children[1];
    wrap.empty();
    const inner = wrap.createEl('div', { cls: 'wa-sidebar-container' });

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      inner.createEl('div', { cls: 'wa-empty', text: 'Open a note to see annotations.' });
      return;
    }

    await this.plugin.renderAnnotationList(inner, view, null);
  }
}

// ─────────────────────────────────────────────
// Floating toolbar (selection → annotate)
// ─────────────────────────────────────────────

class FloatingToolbar {
  constructor(plugin) {
    this.plugin  = plugin;
    this.el      = null;
    this._remove = this._remove.bind(this);
  }

  show(x, y, editor, selection) {
    this._remove();

    const tb = document.createElement('div');
    tb.className = 'wa-floating-toolbar';

    const annotateBtn = document.createElement('button');
    annotateBtn.className   = 'wa-toolbar-annotate';
    annotateBtn.textContent = 'Annotate';
    annotateBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._remove();
      this.plugin.startAnnotation(editor, selection);
    });

    const closeBtn = document.createElement('button');
    closeBtn.className   = 'wa-toolbar-dismiss';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this._remove();
    });

    // On mobile, also show "All Notes" button to open the annotation manager
    if (Platform.isMobile) {
      const allBtn = document.createElement('button');
      allBtn.className   = 'wa-toolbar-all';
      allBtn.textContent = 'Notes';
      allBtn.setAttribute('aria-label', 'All annotations');
      allBtn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._remove();
        this.plugin.openPanel();
      });
      tb.appendChild(annotateBtn);
      tb.appendChild(allBtn);
      tb.appendChild(closeBtn);
    } else {
      tb.appendChild(annotateBtn);
      tb.appendChild(closeBtn);
    }
    document.body.appendChild(tb);
    this.el = tb;

    const w = tb.offsetWidth || 160;
    const h = tb.offsetHeight || 48;

    if (Platform.isMobile) {
      // Pin to bottom of visible viewport — iOS Cut/Copy/Paste owns the area near the selection
      const vvHeight = window.visualViewport?.height ?? window.innerHeight;
      const vvTop    = window.visualViewport?.offsetTop ?? 0;
      tb.style.left      = '50%';
      tb.style.transform = 'translateX(-50%)';
      tb.style.top       = `${vvTop + vvHeight - h - 20}px`;
    } else {
      let left = x - w / 2;
      let top  = y - h - 12;
      left = Math.max(8, Math.min(left, window.innerWidth  - w - 8));
      top  = Math.max(8, Math.min(top,  window.innerHeight - h - 8));
      tb.style.left = `${left}px`;
      tb.style.top  = `${top}px`;
    }

    setTimeout(() => document.addEventListener('pointerdown', this._remove, { once: true }), 150);
  }

  _remove() {
    if (this.el) { this.el.remove(); this.el = null; }
    document.removeEventListener('pointerdown', this._remove);
    if (this._vpReposition && window.visualViewport) {
      window.visualViewport.removeEventListener('resize', this._vpReposition);
      window.visualViewport.removeEventListener('scroll', this._vpReposition);
      this._vpReposition = null;
    }
  }

  destroy() { this._remove(); }
}

// ─────────────────────────────────────────────
// Main plugin
// ─────────────────────────────────────────────

class WritingAnnotationsPlugin extends Plugin {
  async onload() {
    this.toolbar = new FloatingToolbar(this);


    this.registerView(VIEW_TYPE, (leaf) => new AnnotationPanelView(leaf, this));

    // Reading view: make annotated highlights tappable
    this.registerMarkdownPostProcessor((el, ctx) => this._postProcess(el, ctx));

    // Commands
    this.addCommand({
      id:   'add-annotation',
      name: 'Add annotation to selection',
      icon: 'wa-icon',
      editorCallback: (editor) => {
        const sel = editor.getSelection().trim();
        if (!sel) { new Notice('Select some text first.'); return; }
        this.startAnnotation(editor, sel);
      }
    });

    this.addCommand({
      id:       'open-annotations',
      name:     'View all annotations',
      icon:     'wa-icon',
      callback: () => this.openPanel()
    });

    this.addCommand({
      id:   'export-annotations',
      name: 'Export annotations for LLM',
      editorCallback: async (editor, view) => {
        if (!view.file) return;
        const anns = await getAnnotations(this.app, view.file);
        if (!anns.length) { new Notice('No annotations found.'); return; }
        await navigator.clipboard.writeText(buildLLMExport(view.file.name, anns));
        new Notice(`Copied ${anns.length} annotation(s) to clipboard.`);
      }
    });

    this.addRibbonIcon('wa-icon', 'Writing Annotations', () => this.openPanel());

    // Editor context menu — long-press on mobile, right-click on desktop
    this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor, view) => {
      const sel = editor.getSelection().trim();

      // Add new annotation if text is selected
      if (sel) {
        menu.addItem((item) => {
          item.setTitle('Add Annotation').setIcon('wa-icon')
            .onClick(() => this.startAnnotation(editor, sel));
        });
      }

      // Edit existing annotation if cursor line contains one (sync cache read — no await needed)
      if (view?.file) {
        const cache = this.app.metadataCache.getFileCache(view.file);
        const anns  = Array.isArray(cache?.frontmatter?.annotations) ? cache.frontmatter.annotations : [];
        if (anns.length) {
          const lineText = editor.getLine(editor.getCursor().line);
          const ann = anns.find(a => lineText.includes(`==${a.text}==`));
          if (ann) {
            menu.addItem((item) => {
              item.setTitle('Edit Annotation').setIcon('wa-icon')
                .onClick(() => {
                  this._openAnnotationInput(ann.text, async (newNote) => {
                    await updateAnnotation(this.app, view.file, ann.text, newNote);
                    new Notice('Annotation updated.');
                    this._refreshSidebar();
                  }, ann.note);
                });
            });
            menu.addItem((item) => {
              item.setTitle('Resolve Annotation').setIcon('check')
                .onClick(async () => {
                  await atomicRemove(this.app, view.file, ann.text);
                  new Notice('Resolved.');
                  this._refreshSidebar();
                });
            });
            menu.addItem((item) => {
              item.setTitle('Delete Annotation').setIcon('trash')
                .onClick(async () => {
                  await atomicRemove(this.app, view.file, ann.text);
                  this._refreshSidebar();
                });
            });
          }
          // Always offer "View All" in the menu
          menu.addItem((item) => {
            item.setTitle('View All Annotations').setIcon('list')
              .onClick(() => this.openPanel());
          });
        }
      }
    }));

    // Floating toolbar on text selection (mobile + desktop)
    this.registerDomEvent(document, 'selectionchange', () => {
      clearTimeout(this._selTimer);
      this._selTimer = setTimeout(() => this._onSelectionChange(), Platform.isMobile ? 600 : 280);
    });

    // Init the sidebar leaf on startup (same pattern as Calendar plugin — no mobile branching)
    this.app.workspace.onLayoutReady(() => this._initLeaf());
  }

  onunload() {
    this.toolbar.destroy();
    clearTimeout(this._selTimer);
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  // ── Annotate selection ──────────────────────

  // ── Pick bottom bar (mobile) or modal (desktop) ─
  _openAnnotationInput(selectedText, onSubmit, initialValue = '', onResolve = null) {
    new AnnotationInputModal(this.app, selectedText, onSubmit, initialValue, onResolve).open();
  }

  async startAnnotation(editor, selection) {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.file) return;

    // Capture cursor positions BEFORE opening the modal.
    // The modal steals editor focus which clears the active selection —
    // replaceSelection() would then fire into nothing and lose the user's note.
    // replaceRange() with saved positions works regardless of focus state.
    const from = editor.getCursor('from');
    const to   = editor.getCursor('to');

    // ==highlight== only works on a single line in Obsidian.
    // For multiline / long selections, anchor to the first sentence/line.
    const anchor    = textAnchor(selection);
    const truncated = anchor !== selection.trim();

    const onSubmit = async (note) => {
      if (truncated) {
        const anchorRaw = anchor.endsWith('…') ? anchor.slice(0, -1) : anchor;
        const rest = selection.trim().slice(anchorRaw.length);
        editor.replaceRange(`==${anchor}==${rest}`, from, to);
        new Notice('Annotation saved.');
      } else {
        editor.replaceRange(`==${anchor}==`, from, to);
        new Notice('Annotation saved.');
      }
      await addAnnotation(this.app, view.file, anchor, note);
      this._refreshSidebar();
    };

    this._openAnnotationInput(selection, onSubmit);
  }

  // ── Render annotation list (shared by sidebar + modal) ──

  async renderAnnotationList(container, mdView, onClose) {
    container.empty();

    if (!mdView.file) {
      container.createEl('div', { cls: 'wa-empty', text: 'No file open.' });
      return;
    }

    const all     = await getAnnotations(this.app, mdView.file);
    const content = mdView.editor.getValue();

    // ── Reconcile: auto-clean ghost annotations whose == was manually deleted ──
    const live    = all.filter(a => content.includes(`==${a.text}==`));
    const orphans = all.filter(a => !content.includes(`==${a.text}==`));
    if (orphans.length) {
      for (const o of orphans) await removeAnnotation(this.app, mdView.file, o.text);
    }

    const filename = mdView.file.name;

    // ── Header ──────────────────────────────────
    const header = container.createEl('div', { cls: 'wa-panel-header' });
    header.createEl('span', {
      cls:  'wa-panel-title',
      text: `${live.length} annotation${live.length !== 1 ? 's' : ''}`
    });

    const copyAllBtn = header.createEl('button', { cls: 'wa-copy-btn', text: '📋 Copy all' });
    copyAllBtn.addEventListener('click', async () => {
      if (!live.length) { new Notice('No annotations to copy.'); return; }
      await navigator.clipboard.writeText(buildLLMExport(filename, live));
      copyAllBtn.setText('✓ Copied!');
      setTimeout(() => copyAllBtn.setText('📋 Copy all'), 2500);
    });

    if (!live.length) {
      container.createEl('div', {
        cls:  'wa-empty',
        text: 'No annotations yet.\nSelect text and tap 🖊 to add one.'
      });
      return;
    }

    // ── Cards ────────────────────────────────────
    live.forEach((ann) => {
      const item = container.createEl('div', { cls: 'wa-annotation-item' });

      item.createEl('div', { cls: 'wa-item-text',    text: `"${ann.text}"` });
      item.createEl('div', { cls: 'wa-item-comment', text: ann.note });

      const actions = item.createEl('div', { cls: 'wa-item-actions' });

      // ↗ Jump to
      const jumpBtn = actions.createEl('button', { text: '↗ Jump to' });
      jumpBtn.addEventListener('click', () => {
        const idx = mdView.editor.getValue().indexOf(`==${ann.text}==`);
        if (idx === -1) { new Notice('Text not found.'); return; }
        if (onClose) onClose();
        setTimeout(() => {
          this.app.workspace.setActiveLeaf(mdView.leaf, { focus: true });
          const pos = mdView.editor.offsetToPos(idx);
          mdView.editor.setCursor(pos);
          mdView.editor.scrollIntoView({ from: pos, to: pos }, true);
        }, onClose ? 250 : 0);
      });

      // 📋 Copy this annotation
      const copyOneBtn = actions.createEl('button', { cls: 'wa-copy-one-btn', text: '📋' });
      copyOneBtn.setAttribute('aria-label', 'Copy this annotation');
      copyOneBtn.addEventListener('click', async () => {
        await navigator.clipboard.writeText(buildSingleExport(ann));
        copyOneBtn.setText('✓');
        setTimeout(() => copyOneBtn.setText('📋'), 1500);
      });

      // ✓ Done (atomic: remove == from body + remove from frontmatter)
      const doneBtn = actions.createEl('button', { cls: 'wa-done-btn', text: '✓ Done' });
      doneBtn.addEventListener('click', async () => {
        doneBtn.disabled = true;
        doneBtn.setText('…');
        await atomicRemove(this.app, mdView.file, ann.text);
        new Notice('Done.');
        this._refreshSidebar();
        if (onClose) onClose();
      });

      // 🗑 Delete (force-remove from panel even if highlight already gone)
      const deleteBtn = actions.createEl('button', { cls: 'wa-delete-btn', text: '🗑' });
      deleteBtn.setAttribute('aria-label', 'Delete annotation');
      deleteBtn.addEventListener('click', async () => {
        deleteBtn.disabled = true;
        // atomicRemove handles missing == gracefully (skips body mod if not found)
        await atomicRemove(this.app, mdView.file, ann.text);
        this._refreshSidebar();
        if (onClose) onClose();
      });
    });
  }

  // ── Reading view: persistent inline annotation notes ──────

  async _postProcess(el, ctx) {
    if (!ctx.sourcePath) return;
    const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
    if (!file) return;

    await new Promise(r => setTimeout(r, 50));

    const annotations = await getAnnotations(this.app, file);
    if (!annotations.length) return;

    // Track last inserted note per parent block so multiple annotations
    // in the same paragraph stack in DOM order (not reversed)
    const blockLastNote = new Map();

    el.querySelectorAll('mark').forEach((mark) => {
      const markText = mark.textContent?.trim() ?? '';
      const ann = annotations.find(a => a.text === markText || a.text.startsWith(markText));
      if (!ann) return;

      mark.classList.add('wa-annotated-mark');

      const parentBlock =
        mark.closest('p, li, blockquote, h1, h2, h3, h4, h5, h6') ||
        mark.parentElement;

      const noteEl = document.createElement('div');
      noteEl.className = 'wa-inline-note';
      noteEl.textContent = ann.note;

      noteEl.addEventListener('click', () => {
        this._openAnnotationInput(
          ann.text,
          async (newNote) => {
            await updateAnnotation(this.app, file, ann.text, newNote);
            noteEl.textContent = newNote;
            new Notice('Annotation updated.');
            this._refreshSidebar();
          },
          ann.note,
          async () => {
            await atomicRemove(this.app, file, ann.text);
            noteEl.remove();
            new Notice('Resolved.');
            this._refreshSidebar();
          }
        );
      });

      // Insert after the last note for this block (or after the block itself)
      const insertAfter = blockLastNote.get(parentBlock) || parentBlock;
      insertAfter.insertAdjacentElement('afterend', noteEl);
      blockLastNote.set(parentBlock, noteEl);
    });
  }


  // ── Panel ───────────────────────────────────

  openPanel() {
    if (Platform.isMobile) {
      new AnnotationListModal(this.app, this).open();
    } else {
      this._activateSidebar();
    }
  }

  // Create the leaf silently on startup — exact same pattern as Calendar plugin
  _initLeaf() {
    if (this.app.workspace.getLeavesOfType(VIEW_TYPE).length) return;
    this.app.workspace.getRightLeaf(false)?.setViewState({ type: VIEW_TYPE });
  }

  // Called when user explicitly opens the panel — init if needed then reveal
  _activateSidebar() {
    this._initLeaf();
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (leaf) this.app.workspace.revealLeaf(leaf);
  }

  _refreshSidebar() {
    this.app.workspace.getLeavesOfType(VIEW_TYPE)
      .forEach(l => l.view?.refresh?.());
  }

  // ── Selection → floating toolbar ────────────

  _onSelectionChange() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) return;

    const editorEl = document.querySelector('.cm-editor');
    if (!editorEl?.contains(sel.anchorNode)) return;

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;

    const range = sel.getRangeAt(0);
    const rect  = range.getBoundingClientRect();
    if (!rect.width) return;

    // Mobile: pass rect.bottom so toolbar appears below selection (clear of iOS menu)
    // Desktop: pass rect.top so toolbar appears above selection
    const y = Platform.isMobile ? rect.bottom : rect.top;
    this.toolbar.show(
      rect.left + rect.width / 2,
      y,
      view.editor,
      sel.toString().trim()
    );
  }
}

module.exports = WritingAnnotationsPlugin;
