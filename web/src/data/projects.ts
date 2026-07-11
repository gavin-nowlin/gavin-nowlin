export type Project = {
	name: string;
	description: string;
	url: string;
	tag: string;
};

export const projects: Project[] = [
	{
		name: 'MogX',
		description:
			'Gamified looksmaxxing routine tracker — build routines, earn XP, and climb the MogBoard with friends.',
		url: 'https://mogx.app',
		tag: 'Mobile app',
	},
	{
		name: 'viralscripter.com',
		description:
			'TikTok Shop script generator website — turn products into viral affiliate scripts in seconds.',
		url: 'https://viralscripter.com',
		tag: 'Website',
	},
];
