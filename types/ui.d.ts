// What h() in js/ui.js takes as children: nodes, text, and nested lists of them. null, undefined and false are skipped.
export type Child = Node | string | number | boolean | null | undefined | readonly Child[];
