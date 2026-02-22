import plugin from "../plugin.json";
import LRUCache from "./cache.js";

class PathIntellisense {
    constructor() {
        this.directoryCache = new LRUCache();
        this.pathAutoCompletions = null;
        this.aceAfterExecHandler = null;
        this.codeMirrorInputHandler = null;
        this.codeMirrorSwitchHandler = null;
        this.codeMirrorInstalledFileIds = new Set();
        this.codeMirrorAutocompleteExtension = null;
    }

    async init() {
        const editor = editorManager.editor;
        if (!editor) return;

        editor.commands.addCommand({
            name: "pathintellisense:reset_cache",
            description: "Reset PathIntellisense Cache",
            exec: this.clearCache.bind(this)
        });

        if (editorManager.isCodeMirror === true) {
            this.initCodeMirror(editor);
            return;
        }

        this.initAce(editor);
    }

    initAce(editor) {
        const self = this;

        this.pathAutoCompletions = {
            getCompletions: async function (_editor, session, pos, _prefix, callback) {
                try {
                    const currentLine = session.getLine(pos.row);
                    const input = self.getCurrentInput(currentLine, pos.column);
                    const query = self.getPathQuery(input);
                    const resolved = self.resolvePathForInput(query.lookupInput);
                    if (!resolved) {
                        callback(null, []);
                        return;
                    }
                    const entries = await self.getDirectoryEntries(resolved.path);
                    callback(null, self.toAceCompletions(entries, resolved.isNormal));
                } catch (error) {
                    callback(null, []);
                    console.log(error?.message || error);
                }
            }
        };

        editor.completers.unshift(this.pathAutoCompletions);

        this.aceAfterExecHandler = function (e) {
            if (
                e.command.name === "insertstring" &&
                (e.args === "/" || e.args.endsWith("/"))
            ) {
                editor.execCommand("startAutocomplete");
            }
        };
        editor.commands.on("afterExec", this.aceAfterExecHandler);
    }

    initCodeMirror(editor) {
        this.installCodeMirrorCompletionSource();
        this.codeMirrorSwitchHandler = () => {
            this.installCodeMirrorCompletionSource();
        };
        editorManager.on("switch-file", this.codeMirrorSwitchHandler);

        this.codeMirrorInputHandler = (event) => {
            if (typeof event?.data !== "string") return;
            if (event.data !== "/" && !event.data.endsWith("/")) return;
            this.triggerCodeMirrorAutocomplete();
        };
        editor.contentDOM?.addEventListener("input", this.codeMirrorInputHandler);
    }

    installCodeMirrorCompletionSource() {
        const editor = editorManager.editor;
        const activeFileId = editorManager.activeFile?.id;
        if (!editor || !activeFileId) return;
        if (this.codeMirrorInstalledFileIds.has(activeFileId)) return;

        const EditorStateClass = editor.state?.constructor;
        if (!EditorStateClass?.languageData?.of) return;

        if (!this.codeMirrorAutocompleteExtension) {
            this.codeMirrorAutocompleteExtension = EditorStateClass.languageData.of(() => [
                {
                    autocomplete: this.getCodeMirrorCompletions.bind(this)
                }
            ]);
        }

        const appendConfig = editorManager.readOnlyCompartment
            ?.reconfigure([])
            ?.constructor?.appendConfig;

        if (appendConfig?.of) {
            editor.dispatch({
                effects: appendConfig.of(this.codeMirrorAutocompleteExtension)
            });
        } else {
            // Fallback for older/newer Acode variants where appendConfig isn't exposed through editorManager.
            const state = editor.state;
            const baseExtensions = Array.isArray(state?.config?.base)
                ? state.config.base.slice()
                : [];
            baseExtensions.push(this.codeMirrorAutocompleteExtension);
            const nextState = EditorStateClass.create({
                doc: state.doc,
                selection: state.selection,
                extensions: baseExtensions
            });
            editor.setState(nextState);
        }

        this.codeMirrorInstalledFileIds.add(activeFileId);
    }

    triggerCodeMirrorAutocomplete() {
        const editor = editorManager.editor;
        if (!editor) return;

        const commandNames = ["startAutocomplete", "startCompletion", "autocomplete"];
        for (const commandName of commandNames) {
            try {
                if (editor.execCommand?.(commandName)) return;
            } catch (_) {}
        }

        const dispatchCtrlSpace = (metaKey) => {
            const keydown = new KeyboardEvent("keydown", {
                key: " ",
                code: "Space",
                ctrlKey: !metaKey,
                metaKey,
                bubbles: true,
                cancelable: true
            });
            editor.contentDOM?.dispatchEvent(keydown);
            const keyup = new KeyboardEvent("keyup", {
                key: " ",
                code: "Space",
                ctrlKey: !metaKey,
                metaKey,
                bubbles: true,
                cancelable: true
            });
            editor.contentDOM?.dispatchEvent(keyup);
        };

        dispatchCtrlSpace(false);
        dispatchCtrlSpace(true);
    }

    async getCodeMirrorCompletions(context) {
        const fileUri = editorManager.activeFile?.uri;
        if (!fileUri) return null;

        // CodeMirror recommended completion-source style:
        // use matchBefore and explicit completion gating.
        const word = context.matchBefore(/[a-zA-Z0-9/.+_\-$@:]*/);
        if (!word) return null;
        if (word.from === word.to && !context.explicit) return null;

        const input = word.text;
        const query = this.getPathQuery(input);

        if (!context.explicit && !query.isPathLike) return null;

        const resolved = this.resolvePathForInput(query.lookupInput);
        if (!resolved) return null;

        const entries = await this.getDirectoryEntries(resolved.path);
        const options = this.toCodeMirrorCompletions(entries);
        if (!options.length) return null;

        return {
            from: word.to - query.segmentPrefix.length,
            options,
            validFor: /[a-zA-Z0-9.+_\-\s$@:]*$/
        };
    }

    getPathQuery(input) {
        const isPathLike =
            input.startsWith("$HOME/") ||
            input.startsWith("/") ||
            input.startsWith("./") ||
            input.startsWith("../") ||
            input.includes("/");

        if (!isPathLike) {
            return {
                isPathLike: false,
                lookupInput: input,
                segmentPrefix: input
            };
        }

        const lastSlashIndex = input.lastIndexOf("/");
        const lookupInput =
            lastSlashIndex === -1 ? input : input.substring(0, lastSlashIndex + 1);
        const segmentPrefix =
            lastSlashIndex === -1 ? input : input.substring(lastSlashIndex + 1);

        return {
            isPathLike: true,
            lookupInput,
            segmentPrefix
        };
    }

    clearCache() {
        this.directoryCache.resetCache();
        window.toast("Cache Cleared 🔥", 2000);
    }

    resolvePathForInput(input) {
        const fileUri = editorManager.activeFile?.uri;
        if (!fileUri) return null;

        const absolutePath = "$HOME/";
        const currentDirectory = this.removeFileNameAndExtension(fileUri);

        if (input.startsWith(absolutePath)) {
            const folderPath = input.substring(absolutePath.length);
            return {
                path:
                    "content://com.termux.documents/tree/%2Fdata%2Fdata%2Fcom.termux%2Ffiles%2Fhome::/data/data/com.termux/files/home/" +
                    folderPath,
                isNormal: false
            };
        }

        if (
            input.startsWith("/") ||
            input.startsWith("../") ||
            input.startsWith("./") ||
            input.includes("/")
        ) {
            const relativeInput = input.startsWith("./") ? input.substring(1) : input;
            return {
                path: this.resolveRelativePath(currentDirectory, relativeInput),
                isNormal: false
            };
        }

        return {
            path: currentDirectory,
            isNormal: true
        };
    }

    async getDirectoryEntries(path) {
        try {
            const cachedData = await this.directoryCache.getAsync(path);
            if (cachedData) {
                return cachedData;
            }

            const list = await acode.require("fsOperation")(path).lsDir();
            const entries = list.map((item) => ({
                name: item.name,
                isFile: item.isFile
            }));
            await this.directoryCache.setAsync(path, entries);
            return entries;
        } catch (err) {
            console.log(err?.message || err?.toString?.() || "PathIntellisense: lsDir failed");
            return [];
        }
    }

    toAceCompletions(entries, isNormal) {
        const helpers = acode.require("helpers");
        return entries.map((item) => {
            const completion = {
                caption: item.name,
                value: item.name,
                score: isNormal ? 500 : 8000,
                meta: item.isFile ? "File" : "Folder"
            };
            if (
                typeof extraSyntaxHighlightsInstalled !== "undefined" &&
                extraSyntaxHighlightsInstalled
            ) {
                completion.icon = item.isFile
                    ? helpers.getIconForFile(item.name)
                    : "icon folder";
            }
            if (!item.isFile) {
                completion.value += "/";
            }
            return completion;
        });
    }

    toCodeMirrorCompletions(entries) {
        return entries.map((item) => ({
            label: item.isFile ? item.name : `${item.name}/`,
            type: item.isFile ? "property" : "keyword",
            detail: item.isFile ? "File" : "Folder"
        }));
    }

    getCurrentInput(line, column) {
        let input = "";
        let i = column - 1;
        while (i >= 0 && /[a-zA-Z0-9/.+_\-\s$@\:]/.test(line[i])) {
            input = line[i] + input;
            i--;
        }
        return input;
    }

    resolveRelativePath(basePath, relativePath) {
        if (relativePath.startsWith("/")) {
            // Absolute path, return it as is
            return basePath + relativePath;
        }

        const basePathParts = basePath.split("::");
        if (basePathParts.length === 2) {
            const baseUri = basePathParts[0];
            let baseDir = basePathParts[1];

            // Ensure baseDir ends with "/"
            if (!baseDir.endsWith("/")) {
                baseDir += "/";
            }

            const relativeParts = relativePath.split("/");

            for (const part of relativeParts) {
                if (part === "..") {
                    // Move up one directory, but avoid going above the root
                    const lastSlashIndex = baseDir.lastIndexOf(
                        "/",
                        baseDir.length - 2
                    );
                    if (lastSlashIndex !== -1) {
                        baseDir = baseDir.substring(0, lastSlashIndex + 1);
                    }
                } else if (part !== "." && part !== "") {
                    baseDir += part + "/";
                }
            }

            const resolvedPath = baseUri + "::" + baseDir;
            return resolvedPath;
        }

        // Return the basePath unmodified if it doesn't match the expected format
        return basePath;
    }

    removeFileNameAndExtension(filePath) {
        const lastSlashIndex = filePath.lastIndexOf("/");
        const fileName = filePath.substring(lastSlashIndex + 1);
        return filePath.substring(0, filePath.length - fileName.length - 1);
    }

    async destroy() {
        const editor = editorManager.editor;
        if (!editor) return;

        if (editorManager.isCodeMirror === true) {
            if (this.codeMirrorInputHandler) {
                editor.contentDOM?.removeEventListener("input", this.codeMirrorInputHandler);
            }
            if (this.codeMirrorSwitchHandler) {
                editorManager.off("switch-file", this.codeMirrorSwitchHandler);
            }
        } else if (this.pathAutoCompletions) {
            const index = editor.completers.indexOf(this.pathAutoCompletions);
            if (index !== -1) {
                editor.completers.splice(index, 1);
            }
            if (this.aceAfterExecHandler) {
                editor.commands.off("afterExec", this.aceAfterExecHandler);
            }
        }

        editor.commands.removeCommand("pathintellisense:reset_cache");
    }
}

if (window.acode) {
    const acodePlugin = new PathIntellisense();
    acode.setPluginInit(
        plugin.id,
        async (baseUrl, $page, { cacheFileUrl, cacheFile }) => {
            if (!baseUrl.endsWith("/")) {
                baseUrl += "/";
            }
            acodePlugin.baseUrl = baseUrl;
            await acodePlugin.init($page, cacheFile, cacheFileUrl);
        }
    );
    acode.setPluginUnmount(plugin.id, () => {
        acodePlugin.destroy();
    });
}
