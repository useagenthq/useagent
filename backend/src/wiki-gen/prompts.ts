/**
 * Prompt builders for repo-wiki generation.
 *
 * Ported to TypeScript from deepwiki-open (AsyncFuncAI/deepwiki-open, MIT
 * License, (c) 2024 Sheing Ng) — api/services/wiki/prompts.py. The structure and
 * page prompts are kept faithful so the output shape (XML wiki structure; a
 * <details> source block, mermaid diagrams, and `Sources: [path:lines]()`
 * citations per page) matches the reference.
 *
 * The one deliberate adaptation: deepwiki feeds page source content through a
 * RAG retriever. We do not run RAG — the generator reads the referenced files
 * straight from the cloned working tree and appends their contents as a
 * <source_files> block (see buildPagePrompt), so the model still grounds every
 * page in real code.
 */

/** Bumped whenever a prompt changes; part of the per-page regeneration
 *  fingerprint so a prompt edit invalidates prior revisions. */
export const PROMPT_VERSION = "wiki-gen-1";

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  ja: "Japanese (日本語)",
  zh: "Mandarin Chinese (中文)",
  "zh-tw": "Traditional Chinese (繁體中文)",
  es: "Spanish (Español)",
  kr: "Korean (한국어)",
  vi: "Vietnamese (Tiếng Việt)",
  "pt-br": "Brazilian Portuguese (Português Brasileiro)",
  fr: "Français (French)",
  ru: "Русский (Russian)",
};

export function languageName(language: string): string {
  return LANGUAGE_NAMES[language] ?? "English";
}

/**
 * Prompt for generating a single wiki page (port of generatePageContent).
 *
 * `fileLinks` is the pre-built markdown list of `- [path](url)` lines that seeds
 * the required <details> block. `sourceFilesBlock` is our no-RAG addition: the
 * actual contents of the referenced files, which the model must ground on.
 */
export function buildPagePrompt(
  title: string,
  fileLinks: string,
  sourceFilesBlock: string,
  language: string,
): string {
  return `You are an expert technical writer and software architect.
Your task is to generate a comprehensive and accurate technical wiki page in Markdown format about a specific feature, system, or module within a given software project.

You will be given:
1. The "[WIKI_PAGE_TOPIC]" for the page you need to create.
2. A list of "[RELEVANT_SOURCE_FILES]" from the project that you MUST use as the sole basis for the content. You have access to the full content of these files (provided at the end of this prompt). You MUST use AT LEAST 5 relevant source files for comprehensive coverage - if fewer are provided, use as many as you have.

CRITICAL STARTING INSTRUCTION:
The very first thing on the page MUST be a \`<details>\` block listing ALL the \`[RELEVANT_SOURCE_FILES]\` you used to generate the content.
Do not provide any acknowledgements, disclaimers, apologies, or any other preface before the \`<details>\` block. JUST START with the \`<details>\` block.
Format the block EXACTLY like the following template, reproducing it verbatim (do not add line numbers, do not convert the links to plain text, do not add any other text):
<details>
<summary>Relevant source files</summary>

The following files were used as context for generating this wiki page:

${fileLinks}
</details>

Immediately after the \`<details>\` block, the main title of the page should be a H1 Markdown heading: \`# ${title}\`.

Based ONLY on the content of the \`[RELEVANT_SOURCE_FILES]\`:

1.  **Introduction:** Start with a concise introduction (1-2 paragraphs) explaining the purpose, scope, and high-level overview of "${title}" within the context of the overall project. If relevant, link to other potential wiki pages using the format \`[Link Text](#page-anchor-or-id)\`.

2.  **Detailed Sections:** Break down "${title}" into logical sections using H2 (\`##\`) and H3 (\`###\`) Markdown headings. For each section explain the architecture, components, data flow, or logic relevant to the section's focus, as evidenced in the source files, and identify key functions, classes, data structures, API endpoints, or configuration elements.

3.  **Mermaid Diagrams:**
    *   EXTENSIVELY use Mermaid diagrams (e.g., \`flowchart TD\`, \`sequenceDiagram\`, \`classDiagram\`, \`erDiagram\`, \`graph TD\`) to visually represent architectures, flows, relationships, and schemas found in the source files.
    *   Ensure diagrams are accurate and directly derived from information in the \`[RELEVANT_SOURCE_FILES]\`.
    *   Provide a brief explanation before or after each diagram.
    *   CRITICAL: All diagrams MUST follow strict vertical orientation:
        - Use "graph TD" (top-down) for flow diagrams; NEVER use "graph LR".
        - Maximum node width should be 3-4 words.
        - For sequence diagrams start with "sequenceDiagram", define ALL participants at the beginning, and use a colon for labels (A->>B: My Label), never flowchart-style labels.

4.  **Tables:** Use Markdown tables to summarize key features/components, API parameters, configuration options, or data-model fields.

5.  **Code Snippets (OPTIONAL):** Include short, relevant code snippets directly from the \`[RELEVANT_SOURCE_FILES]\` in fenced code blocks with a language identifier.

6.  **Source Citations (EXTREMELY IMPORTANT):**
    *   For EVERY piece of significant information, diagram, table entry, or code snippet, you MUST cite the specific source file(s) and relevant line numbers.
    *   Place citations at the end of the paragraph, under the diagram/table, or after the code snippet.
    *   Use the EXACT format below, and ALWAYS use the FULL repository-relative path exactly as it appears in the "Relevant source files" list above - NEVER a bare filename:
        *   Range: \`Sources: [full/path/file.ext:start_line-end_line]()\`
        *   Single line: \`Sources: [full/path/file.ext:line_number]()\`
        *   Whole file: \`Sources: [full/path/file.ext]()\`
    *   The word \`Sources:\` MUST be placed BEFORE the opening bracket, never inside it.
    *   Leave the parentheses \`()\` EMPTY - they are resolved into real links automatically. Do not put a URL inside them.

7.  **Technical Accuracy:** All information must be derived SOLELY from the \`[RELEVANT_SOURCE_FILES]\`. Do not infer, invent, or use external knowledge. If information is not present, do not include it.

8.  **Clarity and Conciseness:** Use clear, professional, concise technical language suitable for other developers.

IMPORTANT: Generate the content in ${languageName(language)} language.

[WIKI_PAGE_TOPIC]: ${title}

[RELEVANT_SOURCE_FILES] (full content follows):
${sourceFilesBlock}

Remember:
- Ground every claim in the provided source files.
- Prioritize accuracy and direct representation of the code's functionality and structure.
- Structure the document logically for easy understanding by other developers.`;
}

const COMPREHENSIVE_STRUCTURE = `
Create a structured wiki with the following main sections:
- Overview (general information about the project)
- System Architecture (how the system is designed)
- Core Features (key functionality)
- Data Management/Flow: If applicable, how data is stored, processed, accessed, and managed.
- Frontend Components (UI elements, if applicable.)
- Backend Systems (server-side components)
- Model Integration (AI model connections)
- Deployment/Infrastructure (how to deploy, what's the infrastructure like)
- Extensibility and Customization: If the project architecture supports it, explain how to extend or customize it.

Each section should contain relevant pages.

Return your analysis in the following XML format:

<wiki_structure>
  <title>[Overall title for the wiki]</title>
  <description>[Brief description of the repository]</description>
  <sections>
    <section id="section-1">
      <title>[Section title]</title>
      <pages>
        <page_ref>page-1</page_ref>
      </pages>
      <subsections>
        <section_ref>section-2</section_ref>
      </subsections>
    </section>
  </sections>
  <pages>
    <page id="page-1">
      <title>[Page title]</title>
      <description>[Brief description of what this page will cover]</description>
      <importance>high|medium|low</importance>
      <relevant_files>
        <file_path>[Path to a relevant file]</file_path>
      </relevant_files>
      <related_pages>
        <related>page-2</related>
      </related_pages>
      <parent_section>section-1</parent_section>
    </page>
  </pages>
</wiki_structure>
`;

const CONCISE_STRUCTURE = `
Return your analysis in the following XML format:

<wiki_structure>
  <title>[Overall title for the wiki]</title>
  <description>[Brief description of the repository]</description>
  <pages>
    <page id="page-1">
      <title>[Page title]</title>
      <description>[Brief description of what this page will cover]</description>
      <importance>high|medium|low</importance>
      <relevant_files>
        <file_path>[Path to a relevant file]</file_path>
      </relevant_files>
      <related_pages>
        <related>page-2</related>
      </related_pages>
    </page>
  </pages>
</wiki_structure>
`;

/** Prompt for determining the wiki structure (port of determineWikiStructure). */
export function buildStructurePrompt(
  owner: string,
  repo: string,
  fileTree: string,
  readme: string,
  comprehensive: boolean,
  language: string,
): string {
  const structureFormat = comprehensive ? COMPREHENSIVE_STRUCTURE : CONCISE_STRUCTURE;
  const pageCount = comprehensive ? "8-12" : "4-6";
  const kind = comprehensive ? "comprehensive" : "concise";
  return `Analyze this repository ${owner}/${repo} and create a wiki structure for it.

1. The complete file tree of the project:
<file_tree>
${fileTree}
</file_tree>

2. The README file of the project:
<readme>
${readme}
</readme>

I want to create a wiki for this repository. Determine the most logical structure for a wiki based on the repository's content.

IMPORTANT: The wiki content will be generated in ${languageName(language)} language.

When designing the wiki structure, include pages that would benefit from visual diagrams, such as:
- Architecture overviews
- Data flow descriptions
- Component relationships
- Process workflows
- State machines
- Class hierarchies
${structureFormat}
IMPORTANT FORMATTING INSTRUCTIONS:
- Return ONLY the valid XML structure specified above
- DO NOT wrap the XML in markdown code blocks (no \`\`\` or \`\`\`xml)
- DO NOT include any explanation text before or after the XML
- Ensure the XML is properly formatted and valid
- Start directly with <wiki_structure> and end with </wiki_structure>

IMPORTANT:
1. Create ${pageCount} pages that would make a ${kind} wiki for this repository
2. Each page should focus on a specific aspect of the codebase (e.g., architecture, key features, setup)
3. The relevant_files should be actual files from the repository that would be used to generate that page
4. Return ONLY valid XML with the structure specified above, with no markdown code block delimiters`;
}
