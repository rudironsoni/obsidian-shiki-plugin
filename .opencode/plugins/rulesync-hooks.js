export const RulesyncHooksPlugin = async ({ $ }) => {
	return {
		event: async ({ event }) => {
			if (event.type === 'session.created') {
				await $`echo 'obsidian-shiki-plugin harness active | Desktop + Mobile emulation | MCPs: obsidian-cli, electron-devtools'`;
			}
		},
		'tool.execute.after': async input => {
			{
				const __re = new RegExp('Write|Edit');
				if (__re.test(input.tool)) {
					await $`git diff --name-only | grep '\\.ts$' >/dev/null && bun run typecheck || true`;
				}
			}
		},
		'tool.execute.before': async input => {
			{
				const __re = new RegExp('Bash');
				if (__re.test(input.tool)) {
					await $`echo 'Executing bash command. Avoid destructive operations on dist/ and exampleVault/'`;
				}
			}
		},
	};
};
