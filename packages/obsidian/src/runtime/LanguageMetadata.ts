// Generated from bundled grammar metadata. Do not import runtime grammar modules here; this file is used on startup.
const LANGUAGE_BLACKLIST = new Set(['c++', 'c#', 'f#', 'mermaid']);
const LANGUAGE_SPECIAL = new Set(['plaintext', 'txt', 'text', 'plain', 'ansi']);

const LANGUAGE_METADATA = [
	{
		"name": "abap",
		"aliases": []
	},
	{
		"name": "actionscript-3",
		"aliases": []
	},
	{
		"name": "ada",
		"aliases": []
	},
	{
		"name": "angular-expression",
		"aliases": []
	},
	{
		"name": "angular-html",
		"aliases": []
	},
	{
		"name": "angular-ts",
		"aliases": []
	},
	{
		"name": "apache",
		"aliases": []
	},
	{
		"name": "apex",
		"aliases": []
	},
	{
		"name": "apl",
		"aliases": []
	},
	{
		"name": "applescript",
		"aliases": []
	},
	{
		"name": "ara",
		"aliases": []
	},
	{
		"name": "asciidoc",
		"aliases": [
			"adoc"
		]
	},
	{
		"name": "asm",
		"aliases": []
	},
	{
		"name": "astro",
		"aliases": []
	},
	{
		"name": "awk",
		"aliases": []
	},
	{
		"name": "ballerina",
		"aliases": []
	},
	{
		"name": "bat",
		"aliases": [
			"batch"
		]
	},
	{
		"name": "beancount",
		"aliases": []
	},
	{
		"name": "berry",
		"aliases": [
			"be"
		]
	},
	{
		"name": "bibtex",
		"aliases": []
	},
	{
		"name": "bicep",
		"aliases": []
	},
	{
		"name": "bird2",
		"aliases": [
			"bird"
		]
	},
	{
		"name": "blade",
		"aliases": []
	},
	{
		"name": "bsl",
		"aliases": [
			"1c"
		]
	},
	{
		"name": "c",
		"aliases": []
	},
	{
		"name": "c3",
		"aliases": []
	},
	{
		"name": "cadence",
		"aliases": [
			"cdc"
		]
	},
	{
		"name": "cairo",
		"aliases": []
	},
	{
		"name": "clarity",
		"aliases": []
	},
	{
		"name": "clojure",
		"aliases": [
			"clj"
		]
	},
	{
		"name": "cmake",
		"aliases": []
	},
	{
		"name": "cobol",
		"aliases": []
	},
	{
		"name": "codeowners",
		"aliases": []
	},
	{
		"name": "codeql",
		"aliases": [
			"ql"
		]
	},
	{
		"name": "coffee",
		"aliases": [
			"coffeescript"
		]
	},
	{
		"name": "common-lisp",
		"aliases": [
			"lisp"
		]
	},
	{
		"name": "coq",
		"aliases": []
	},
	{
		"name": "cpp",
		"aliases": [
			"c++"
		]
	},
	{
		"name": "cpp-macro",
		"aliases": []
	},
	{
		"name": "crystal",
		"aliases": []
	},
	{
		"name": "csharp",
		"aliases": [
			"c#",
			"cs"
		]
	},
	{
		"name": "css",
		"aliases": []
	},
	{
		"name": "csv",
		"aliases": []
	},
	{
		"name": "cue",
		"aliases": []
	},
	{
		"name": "cypher",
		"aliases": [
			"cql"
		]
	},
	{
		"name": "d",
		"aliases": []
	},
	{
		"name": "dart",
		"aliases": []
	},
	{
		"name": "dax",
		"aliases": []
	},
	{
		"name": "desktop",
		"aliases": []
	},
	{
		"name": "diff",
		"aliases": []
	},
	{
		"name": "docker",
		"aliases": [
			"dockerfile"
		]
	},
	{
		"name": "dotenv",
		"aliases": []
	},
	{
		"name": "dream-maker",
		"aliases": []
	},
	{
		"name": "edge",
		"aliases": []
	},
	{
		"name": "elixir",
		"aliases": []
	},
	{
		"name": "elm",
		"aliases": []
	},
	{
		"name": "emacs-lisp",
		"aliases": [
			"elisp"
		]
	},
	{
		"name": "erb",
		"aliases": []
	},
	{
		"name": "erlang",
		"aliases": [
			"erl"
		]
	},
	{
		"name": "fennel",
		"aliases": []
	},
	{
		"name": "fish",
		"aliases": []
	},
	{
		"name": "fluent",
		"aliases": [
			"ftl"
		]
	},
	{
		"name": "fortran-fixed-form",
		"aliases": [
			"f",
			"for",
			"f77"
		]
	},
	{
		"name": "fortran-free-form",
		"aliases": [
			"f90",
			"f95",
			"f03",
			"f08",
			"f18"
		]
	},
	{
		"name": "fsharp",
		"aliases": [
			"f#",
			"fs"
		]
	},
	{
		"name": "gdresource",
		"aliases": [
			"tscn",
			"tres"
		]
	},
	{
		"name": "gdscript",
		"aliases": [
			"gd"
		]
	},
	{
		"name": "gdshader",
		"aliases": []
	},
	{
		"name": "genie",
		"aliases": []
	},
	{
		"name": "gherkin",
		"aliases": []
	},
	{
		"name": "git-commit",
		"aliases": []
	},
	{
		"name": "git-rebase",
		"aliases": []
	},
	{
		"name": "gleam",
		"aliases": []
	},
	{
		"name": "glimmer-js",
		"aliases": [
			"gjs"
		]
	},
	{
		"name": "glimmer-ts",
		"aliases": [
			"gts"
		]
	},
	{
		"name": "glsl",
		"aliases": []
	},
	{
		"name": "gn",
		"aliases": []
	},
	{
		"name": "gnuplot",
		"aliases": []
	},
	{
		"name": "go",
		"aliases": []
	},
	{
		"name": "graphql",
		"aliases": [
			"gql"
		]
	},
	{
		"name": "groovy",
		"aliases": []
	},
	{
		"name": "hack",
		"aliases": []
	},
	{
		"name": "haml",
		"aliases": []
	},
	{
		"name": "handlebars",
		"aliases": [
			"hbs"
		]
	},
	{
		"name": "haskell",
		"aliases": [
			"hs"
		]
	},
	{
		"name": "haxe",
		"aliases": []
	},
	{
		"name": "hcl",
		"aliases": []
	},
	{
		"name": "hjson",
		"aliases": []
	},
	{
		"name": "hlsl",
		"aliases": []
	},
	{
		"name": "html",
		"aliases": []
	},
	{
		"name": "html-derivative",
		"aliases": []
	},
	{
		"name": "http",
		"aliases": []
	},
	{
		"name": "hurl",
		"aliases": []
	},
	{
		"name": "hxml",
		"aliases": []
	},
	{
		"name": "hy",
		"aliases": []
	},
	{
		"name": "imba",
		"aliases": []
	},
	{
		"name": "ini",
		"aliases": [
			"properties"
		]
	},
	{
		"name": "java",
		"aliases": []
	},
	{
		"name": "javascript",
		"aliases": [
			"js",
			"mjs",
			"cjs"
		]
	},
	{
		"name": "jinja",
		"aliases": []
	},
	{
		"name": "jinja-html",
		"aliases": []
	},
	{
		"name": "jison",
		"aliases": []
	},
	{
		"name": "json",
		"aliases": []
	},
	{
		"name": "json5",
		"aliases": []
	},
	{
		"name": "jsonc",
		"aliases": []
	},
	{
		"name": "jsonl",
		"aliases": []
	},
	{
		"name": "jsonnet",
		"aliases": []
	},
	{
		"name": "jssm",
		"aliases": [
			"fsl"
		]
	},
	{
		"name": "jsx",
		"aliases": []
	},
	{
		"name": "julia",
		"aliases": [
			"jl"
		]
	},
	{
		"name": "just",
		"aliases": []
	},
	{
		"name": "kdl",
		"aliases": []
	},
	{
		"name": "kotlin",
		"aliases": [
			"kt",
			"kts"
		]
	},
	{
		"name": "kusto",
		"aliases": [
			"kql"
		]
	},
	{
		"name": "latex",
		"aliases": []
	},
	{
		"name": "lean",
		"aliases": [
			"lean4"
		]
	},
	{
		"name": "less",
		"aliases": []
	},
	{
		"name": "liquid",
		"aliases": []
	},
	{
		"name": "llvm",
		"aliases": []
	},
	{
		"name": "log",
		"aliases": []
	},
	{
		"name": "logo",
		"aliases": []
	},
	{
		"name": "lua",
		"aliases": []
	},
	{
		"name": "luau",
		"aliases": []
	},
	{
		"name": "make",
		"aliases": [
			"makefile"
		]
	},
	{
		"name": "markdown",
		"aliases": [
			"md"
		]
	},
	{
		"name": "marko",
		"aliases": []
	},
	{
		"name": "matlab",
		"aliases": []
	},
	{
		"name": "mdc",
		"aliases": []
	},
	{
		"name": "mdx",
		"aliases": []
	},
	{
		"name": "mermaid",
		"aliases": [
			"mmd"
		]
	},
	{
		"name": "mipsasm",
		"aliases": [
			"mips"
		]
	},
	{
		"name": "mojo",
		"aliases": []
	},
	{
		"name": "moonbit",
		"aliases": [
			"mbt",
			"mbti"
		]
	},
	{
		"name": "move",
		"aliases": []
	},
	{
		"name": "narrat",
		"aliases": [
			"nar"
		]
	},
	{
		"name": "nextflow",
		"aliases": [
			"nf"
		]
	},
	{
		"name": "nextflow-groovy",
		"aliases": []
	},
	{
		"name": "nginx",
		"aliases": []
	},
	{
		"name": "nim",
		"aliases": []
	},
	{
		"name": "nix",
		"aliases": []
	},
	{
		"name": "nushell",
		"aliases": [
			"nu"
		]
	},
	{
		"name": "objective-c",
		"aliases": [
			"objc"
		]
	},
	{
		"name": "objective-cpp",
		"aliases": []
	},
	{
		"name": "ocaml",
		"aliases": []
	},
	{
		"name": "odin",
		"aliases": []
	},
	{
		"name": "openscad",
		"aliases": [
			"scad"
		]
	},
	{
		"name": "pascal",
		"aliases": []
	},
	{
		"name": "perl",
		"aliases": []
	},
	{
		"name": "php",
		"aliases": []
	},
	{
		"name": "pkl",
		"aliases": []
	},
	{
		"name": "plsql",
		"aliases": []
	},
	{
		"name": "po",
		"aliases": [
			"pot",
			"potx"
		]
	},
	{
		"name": "polar",
		"aliases": []
	},
	{
		"name": "postcss",
		"aliases": []
	},
	{
		"name": "powerquery",
		"aliases": []
	},
	{
		"name": "powershell",
		"aliases": [
			"ps",
			"ps1"
		]
	},
	{
		"name": "prisma",
		"aliases": []
	},
	{
		"name": "prolog",
		"aliases": []
	},
	{
		"name": "proto",
		"aliases": [
			"protobuf"
		]
	},
	{
		"name": "pug",
		"aliases": [
			"jade"
		]
	},
	{
		"name": "puppet",
		"aliases": []
	},
	{
		"name": "purescript",
		"aliases": []
	},
	{
		"name": "python",
		"aliases": [
			"py"
		]
	},
	{
		"name": "qml",
		"aliases": []
	},
	{
		"name": "qmldir",
		"aliases": []
	},
	{
		"name": "qss",
		"aliases": []
	},
	{
		"name": "r",
		"aliases": []
	},
	{
		"name": "racket",
		"aliases": []
	},
	{
		"name": "raku",
		"aliases": [
			"perl6"
		]
	},
	{
		"name": "razor",
		"aliases": []
	},
	{
		"name": "reg",
		"aliases": []
	},
	{
		"name": "regexp",
		"aliases": [
			"regex"
		]
	},
	{
		"name": "rel",
		"aliases": []
	},
	{
		"name": "riscv",
		"aliases": []
	},
	{
		"name": "ron",
		"aliases": []
	},
	{
		"name": "rosmsg",
		"aliases": []
	},
	{
		"name": "rst",
		"aliases": []
	},
	{
		"name": "ruby",
		"aliases": [
			"rb"
		]
	},
	{
		"name": "rust",
		"aliases": [
			"rs"
		]
	},
	{
		"name": "sas",
		"aliases": []
	},
	{
		"name": "sass",
		"aliases": []
	},
	{
		"name": "scala",
		"aliases": []
	},
	{
		"name": "scheme",
		"aliases": []
	},
	{
		"name": "scss",
		"aliases": []
	},
	{
		"name": "sdbl",
		"aliases": [
			"1c-query"
		]
	},
	{
		"name": "shaderlab",
		"aliases": [
			"shader"
		]
	},
	{
		"name": "shellscript",
		"aliases": [
			"bash",
			"sh",
			"shell",
			"zsh"
		]
	},
	{
		"name": "shellsession",
		"aliases": [
			"console"
		]
	},
	{
		"name": "smalltalk",
		"aliases": []
	},
	{
		"name": "solidity",
		"aliases": []
	},
	{
		"name": "soy",
		"aliases": [
			"closure-templates"
		]
	},
	{
		"name": "sparql",
		"aliases": []
	},
	{
		"name": "splunk",
		"aliases": [
			"spl"
		]
	},
	{
		"name": "sql",
		"aliases": []
	},
	{
		"name": "ssh-config",
		"aliases": []
	},
	{
		"name": "stata",
		"aliases": []
	},
	{
		"name": "stylus",
		"aliases": [
			"styl"
		]
	},
	{
		"name": "surrealql",
		"aliases": [
			"surql"
		]
	},
	{
		"name": "svelte",
		"aliases": []
	},
	{
		"name": "swift",
		"aliases": []
	},
	{
		"name": "system-verilog",
		"aliases": []
	},
	{
		"name": "systemd",
		"aliases": []
	},
	{
		"name": "talonscript",
		"aliases": [
			"talon"
		]
	},
	{
		"name": "tasl",
		"aliases": []
	},
	{
		"name": "tcl",
		"aliases": []
	},
	{
		"name": "templ",
		"aliases": []
	},
	{
		"name": "terraform",
		"aliases": [
			"tf",
			"tfvars"
		]
	},
	{
		"name": "tex",
		"aliases": []
	},
	{
		"name": "toml",
		"aliases": []
	},
	{
		"name": "ts-tags",
		"aliases": [
			"lit"
		]
	},
	{
		"name": "tsv",
		"aliases": []
	},
	{
		"name": "tsx",
		"aliases": []
	},
	{
		"name": "turtle",
		"aliases": []
	},
	{
		"name": "twig",
		"aliases": []
	},
	{
		"name": "typescript",
		"aliases": [
			"ts",
			"mts",
			"cts"
		]
	},
	{
		"name": "typespec",
		"aliases": [
			"tsp"
		]
	},
	{
		"name": "typst",
		"aliases": [
			"typ"
		]
	},
	{
		"name": "v",
		"aliases": []
	},
	{
		"name": "vala",
		"aliases": []
	},
	{
		"name": "vb",
		"aliases": [
			"cmd"
		]
	},
	{
		"name": "verilog",
		"aliases": []
	},
	{
		"name": "vhdl",
		"aliases": []
	},
	{
		"name": "viml",
		"aliases": [
			"vim",
			"vimscript"
		]
	},
	{
		"name": "vue",
		"aliases": []
	},
	{
		"name": "vue-html",
		"aliases": []
	},
	{
		"name": "vue-vine",
		"aliases": []
	},
	{
		"name": "vyper",
		"aliases": [
			"vy"
		]
	},
	{
		"name": "wasm",
		"aliases": []
	},
	{
		"name": "wenyan",
		"aliases": [
			"文言"
		]
	},
	{
		"name": "wgsl",
		"aliases": []
	},
	{
		"name": "wikitext",
		"aliases": [
			"mediawiki",
			"wiki"
		]
	},
	{
		"name": "wit",
		"aliases": []
	},
	{
		"name": "wolfram",
		"aliases": [
			"wl"
		]
	},
	{
		"name": "xml",
		"aliases": []
	},
	{
		"name": "xsl",
		"aliases": []
	},
	{
		"name": "yaml",
		"aliases": [
			"yml"
		]
	},
	{
		"name": "zenscript",
		"aliases": []
	},
	{
		"name": "zig",
		"aliases": []
	}
] as const;

const ALIAS_TO_NAME = new Map<string, string>();
const ALL_LANGUAGE_NAMES = new Set<string>();
for (const grammar of LANGUAGE_METADATA) {
	ALL_LANGUAGE_NAMES.add(grammar.name);
	ALIAS_TO_NAME.set(grammar.name.toLowerCase(), grammar.name);
	for (const alias of grammar.aliases) {
		ALL_LANGUAGE_NAMES.add(alias);
		ALIAS_TO_NAME.set(alias.toLowerCase(), grammar.name);
	}
}
for (const special of LANGUAGE_SPECIAL) {
	ALL_LANGUAGE_NAMES.add(special);
	ALIAS_TO_NAME.set(special.toLowerCase(), 'plaintext');
}

export function isMarkdownProcessorSafeLanguage(language: string): boolean {
	return !LANGUAGE_BLACKLIST.has(language.toLowerCase());
}

export function getSpecialLanguages(): string[] {
	return [...LANGUAGE_SPECIAL];
}

export function getObsidianSafeLanguageNames(): string[] {
	return [...ALL_LANGUAGE_NAMES].filter(isMarkdownProcessorSafeLanguage);
}

export function resolveLanguageAliasFromMetadata(language: string): string | undefined {
	return ALIAS_TO_NAME.get(language.toLowerCase());
}
