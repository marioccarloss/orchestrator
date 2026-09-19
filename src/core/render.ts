import { renderFlowHarnessBadge } from "./flow-wizard.js";
import { requiresJudgment, type PlanCapsule, type FlowState, type MergedVerdict } from "./flow-schema.js";
import type { EffectiveHarnessModels } from "./harness-models.js";
import type {
  ResearchCapsulePayload,
  Requirement,
  SddTask,
  SpecCapsulePayload,
  TaskGraphPayload,
  SddValidationIssue,
} from "./sdd-schema.js";
import type { IntentAssessmentPayload, IntentBriefPayload, IntentDisplayPayload, IntentNeedsInputPayload, IntentProposedPayload } from "./intent-schema.js";
import type { FlowUsageSummary } from "./flow-metrics.js";
import type { AtlasGraph } from "./atlas.js";
import { normalizeUserLanguage, type UserLanguage } from "./language.js";

interface RenderMessages {
  readonly common: {
    readonly none: string; readonly noneFeminine: string; readonly yes: string; readonly no: string;
    readonly files: string; readonly tests: string; readonly tasks: string; readonly generatedBy: string;
  };
  readonly coverage: {
    readonly heading: string; readonly fresh: string; readonly reindexed: string;
    readonly unsupported: string; readonly unresolvedImports: string; readonly parseErrors: string;
  };
  readonly workspace: {
    readonly title: string; readonly repositories: string; readonly languages: string; readonly nodes: string;
  };
  readonly plan: {
    readonly title: string; readonly summary: string; readonly rootCause: string; readonly affectedFiles: string;
    readonly noSpecificTests: string; readonly verification: string; readonly file: string; readonly action: string;
    readonly risk: string; readonly reason: string; readonly test: string; readonly type: string; readonly description: string;
  };
  readonly progress: readonly [string, string, string, string, string, string, string, string];
  readonly intent: {
    readonly title: string; readonly problem: string; readonly outcome: string; readonly signals: string;
    readonly constraints: string; readonly next: string; readonly nextDetail: string;
    readonly proposedTitle: string; readonly sweeps: string; readonly assumptions: string; readonly unresolved: string;
    readonly suggestedDefault: string; readonly sources: string; readonly confirmProposed: string;
    readonly needsInputTitle: string;
  };
  readonly flow: {
    readonly title: string; readonly progress: string; readonly estimatedCost: string; readonly tokens: string;
    readonly cache: string; readonly sessions: string; readonly workspace: string; readonly started: string;
    readonly difficulty: string; readonly riskLane: string; readonly laneReason: string; readonly ticket: string;
    readonly titleLabel: string; readonly branch: string; readonly base: string; readonly plan: string;
    readonly contextBudget: string; readonly hydrations: string; readonly truncated: string;
  };
  readonly explanation: {
    readonly title: string; readonly what: string; readonly why: string; readonly how: string; readonly proof: string;
    readonly defaultWhy: string; readonly taskVerification: string;
  };
  readonly verdict: {
    readonly title: string; readonly approved: string; readonly rejected: string; readonly summary: string;
    readonly judge: string; readonly critical: string; readonly warnings: string; readonly suggestions: string;
    readonly verifiedEvidence: string; readonly severity: string; readonly finding: string; readonly location: string;
    readonly evidence: string; readonly merged: string;
  };
  readonly proposal: { readonly generated: string; readonly promptTitle: string; readonly copied: string };
  readonly research: {
    readonly title: string; readonly objective: string; readonly evidence: string; readonly reference: string;
    readonly source: string; readonly storedSlice: string; readonly contracts: string; readonly relevantNodes: string;
    readonly constraints: string; readonly unknowns: string; readonly generated: string;
  };
  readonly spec: {
    readonly title: string; readonly goal: string; readonly inScope: string; readonly outScope: string;
    readonly requirements: string; readonly risks: string; readonly given: string; readonly when: string;
    readonly then: string; readonly generated: string;
  };
  readonly taskGraph: {
    readonly title: string; readonly completed: string; readonly dependsOn: string; readonly requirements: string;
    readonly intent: string; readonly symbols: string; readonly evidence: string; readonly allowedFiles: string;
    readonly forbiddenGlobs: string; readonly evidenced: string; readonly invariants: string; readonly verification: string;
    readonly mustPass: string; readonly advisory: string; readonly doneWhen: string; readonly generated: string;
  };
  readonly validation: { readonly valid: string; readonly errors: string; readonly warnings: string };
  readonly blueprint: {
    readonly mode: string; readonly date: string; readonly executiveSummary: string; readonly requestIntent: string;
    readonly transversalImpact: string; readonly noImpact: string; readonly assumptions: string; readonly noAssumptions: string;
    readonly designSpec: string; readonly coreEntities: string; readonly noEntities: string; readonly invariants: string;
    readonly standardRules: string; readonly contracts: string; readonly noContracts: string; readonly testConditions: string;
    readonly defaultTests: string; readonly taskBreakdown: string; readonly pendingBreakdown: string;
    readonly approved: string; readonly sddEntities: string; readonly assumed: string; readonly inferences: string;
    readonly exactSpec: string; readonly summary: string; readonly artifact: string; readonly artifactsSaved: string;
    readonly safetyGate: string; readonly action: string; readonly repo: string; readonly title: string;
    readonly safetyTicket: string;
  };
}

export const MESSAGES = {
  es: {
    common: { none: "Ninguno", noneFeminine: "Ninguna", yes: "sí", no: "no", files: "archivos", tests: "tests", tasks: "tareas", generatedBy: "Generado por mr-orchestrator" },
    coverage: { heading: "cobertura", fresh: "fresca", reindexed: "no (reindexada)", unsupported: "no soportados", unresolvedImports: "imports sin resolver", parseErrors: "errores de parseo" },
    workspace: { title: "Mapa del Workspace de Atlas", repositories: "repositorios", languages: "lenguajes", nodes: "nodos" },
    plan: { title: "Plan de Implementación", summary: "Resumen", rootCause: "Causa Raíz", affectedFiles: "Archivos Afectados", noSpecificTests: "Sin tests específicos planificados.", verification: "Verificación", file: "Archivo", action: "Acción", risk: "Riesgo", reason: "Razón", test: "Test", type: "Tipo", description: "Descripción" },
    progress: ["Ticket", "Intención", "Investigación", "Planificación", "Implementación", "Revisión", "Revisión/Corrección", "Entrega"],
    intent: { title: "Intención, en breve", problem: "Problema", outcome: "Resultado", signals: "Señales de aceptación", constraints: "Restricciones", next: "Siguiente paso", nextDetail: "Confirma esta intención antes de explorar código.", proposedTitle: "Borrador de intención (revisar antes de explorar)", sweeps: "Barridos ejecutados", assumptions: "Supuestos inferidos", unresolved: "Huecos pendientes", suggestedDefault: "Default sugerido", sources: "Fuentes por campo", confirmProposed: "Confirma el borrador con mr_flow_intent o refínalo con mr_sdd_submit kind=intent." , needsInputTitle: "Intención incompleta — aclaración excepcional" },
    flow: { title: "Estado del Flujo", progress: "Progreso", estimatedCost: "Coste estimado por OpenCode", tokens: "tokens entrada/salida/razonamiento", cache: "caché", sessions: "sesiones", workspace: "Workspace", started: "Iniciado", difficulty: "Dificultad", riskLane: "Carril de riesgo", laneReason: "Motivo del carril", ticket: "Ticket", titleLabel: "Título", branch: "Rama", base: "base", plan: "Plan", contextBudget: "Contexto hidratado", hydrations: "hidrataciones", truncated: "recortados" },
    explanation: { title: "Plan, en breve", what: "Qué", why: "Por qué", how: "Cómo", proof: "Prueba", defaultWhy: "Cumplir los criterios de aceptación con el menor cambio seguro.", taskVerification: "verificación específica de cada tarea" },
    verdict: { title: "Veredicto del Día del Juicio", approved: "APROBADO", rejected: "RECHAZADO", summary: "Resumen", judge: "Juez", critical: "Hallazgos Críticos", warnings: "Advertencias", suggestions: "Sugerencias", verifiedEvidence: "Evidencia Verificada", severity: "Severidad", finding: "Hallazgo", location: "Ubicación", evidence: "Evidencia", merged: "Fusionado el" },
    proposal: { generated: "Propuesta generada por mr-orchestrator /propose", promptTitle: "Prompt Generado", copied: "Copiado al portapapeles por mr-orchestrator /prompt" },
    research: { title: "Investigación", objective: "Objetivo", evidence: "Evidencia", reference: "Referencia", source: "Fuente", storedSlice: "slice guardado", contracts: "Contratos", relevantNodes: "Nodos Relevantes (Atlas)", constraints: "Restricciones", unknowns: "Incógnitas", generated: "Generado por script desde ResearchCapsule." },
    spec: { title: "Especificación", goal: "Meta", inScope: "Dentro del Alcance", outScope: "Fuera del Alcance", requirements: "Requisitos y Criterios de Aceptación", risks: "Riesgos", given: "Dado", when: "Cuando", then: "Entonces", generated: "Generado por script desde SpecCapsule." },
    taskGraph: { title: "Tareas", completed: "completadas", dependsOn: "Depende de", requirements: "Requisitos", intent: "Intención", symbols: "Símbolos", evidence: "Evidencia", allowedFiles: "Archivos permitidos", forbiddenGlobs: "Globs prohibidos", evidenced: "Evidenciado", invariants: "Invariantes", verification: "Verificación", mustPass: "debe pasar", advisory: "informativa", doneWhen: "Hecho cuando", generated: "Generado por script desde TaskGraph." },
    validation: { valid: "✅ Sin problemas de validación.", errors: "Errores", warnings: "Advertencias" },
    blueprint: { mode: "Modo", date: "Fecha", executiveSummary: "Resumen Ejecutivo (RPI - Intención de la Solicitud)", requestIntent: "Intención del Requerimiento", transversalImpact: "Impacto Transversal", noImpact: "Sin impactos colaterales detectados.", assumptions: "Supuestos e Inferencias Asumidas", noAssumptions: "Ninguno; requerimiento completamente delimitado.", designSpec: "Especificación de Diseño (SDD)", coreEntities: "Entidades Core", noEntities: "No se definieron nuevas entidades.", invariants: "Invariantes No Negociables", standardRules: "Reglas estándar del proyecto.", contracts: "Contratos de Datos y APIs", noContracts: "No hay nuevos contratos explícitos.", testConditions: "Condiciones de Verificación y Test", defaultTests: "Validación mediante suite de tests estándar.", taskBreakdown: "Plan de Desglose en Tareas (GitHub Projects v2)", pendingBreakdown: "Pendiente de desglose en fase transaccional.", approved: "Blueprint Aprobado", sddEntities: "Entidades SDD", assumed: "Supuestos asumidos", inferences: "inferencias", exactSpec: "especificación exacta", summary: "Resumen", artifact: "Artefacto", artifactsSaved: "Artefactos guardados", safetyGate: "COMPUERTA DE SEGURIDAD: MUTACIÓN EN GITHUB PROJECTS", action: "Acción", repo: "Repo", title: "Título", safetyTicket: "Ticket de Safety Gate (obligatorio para mutar)" },
  },
  en: {
    common: { none: "None", noneFeminine: "None", yes: "yes", no: "no", files: "files", tests: "tests", tasks: "tasks", generatedBy: "Generated by mr-orchestrator" },
    coverage: { heading: "coverage", fresh: "fresh", reindexed: "no (reindexed)", unsupported: "unsupported", unresolvedImports: "unresolved imports", parseErrors: "parse errors" },
    workspace: { title: "Atlas Workspace Map", repositories: "repositories", languages: "languages", nodes: "nodes" },
    plan: { title: "Implementation Plan", summary: "Summary", rootCause: "Root Cause", affectedFiles: "Affected Files", noSpecificTests: "No specific tests planned.", verification: "Verification", file: "File", action: "Action", risk: "Risk", reason: "Reason", test: "Test", type: "Type", description: "Description" },
    progress: ["Ticket", "Intent", "Research", "Planning", "Implementation", "Review", "Review/Fix", "Delivery"],
    intent: { title: "Intent at a glance", problem: "Problem", outcome: "Outcome", signals: "Acceptance signals", constraints: "Constraints", next: "Next step", nextDetail: "Confirm this intent before exploring code.", proposedTitle: "Intent draft (review before explore)", sweeps: "Sweeps completed", assumptions: "Inferred assumptions", unresolved: "Remaining gaps", suggestedDefault: "Suggested default", sources: "Field sources", confirmProposed: "Confirm the draft with mr_flow_intent or refine via mr_sdd_submit kind=intent.", needsInputTitle: "Intent incomplete — exceptional clarification" },
    flow: { title: "Flow Status", progress: "Progress", estimatedCost: "OpenCode estimated cost", tokens: "input/output/reasoning tokens", cache: "cache", sessions: "sessions", workspace: "Workspace", started: "Started", difficulty: "Difficulty", riskLane: "Risk lane", laneReason: "Lane reason", ticket: "Ticket", titleLabel: "Title", branch: "Branch", base: "base", plan: "Plan", contextBudget: "Hydrated context", hydrations: "hydrations", truncated: "truncated" },
    explanation: { title: "Plan at a glance", what: "What", why: "Why", how: "How", proof: "Proof", defaultWhy: "Meet the acceptance criteria with the smallest safe change.", taskVerification: "task-specific verification" },
    verdict: { title: "Judgment Day Verdict", approved: "APPROVED", rejected: "REJECTED", summary: "Summary", judge: "Judge", critical: "Critical Findings", warnings: "Warnings", suggestions: "Suggestions", verifiedEvidence: "Verified Evidence", severity: "Severity", finding: "Finding", location: "Location", evidence: "Evidence", merged: "Merged at" },
    proposal: { generated: "Proposal generated by mr-orchestrator /propose", promptTitle: "Generated Prompt", copied: "Copied to the clipboard by mr-orchestrator /prompt" },
    research: { title: "Research", objective: "Objective", evidence: "Evidence", reference: "Reference", source: "Source", storedSlice: "stored slice", contracts: "Contracts", relevantNodes: "Relevant Nodes (Atlas)", constraints: "Constraints", unknowns: "Unknowns", generated: "Generated by script from ResearchCapsule." },
    spec: { title: "Specification", goal: "Goal", inScope: "In Scope", outScope: "Out of Scope", requirements: "Requirements and Acceptance Criteria", risks: "Risks", given: "Given", when: "When", then: "Then", generated: "Generated by script from SpecCapsule." },
    taskGraph: { title: "Tasks", completed: "completed", dependsOn: "Depends on", requirements: "Requirements", intent: "Intent", symbols: "Symbols", evidence: "Evidence", allowedFiles: "Allowed files", forbiddenGlobs: "Forbidden globs", evidenced: "Evidenced", invariants: "Invariants", verification: "Verification", mustPass: "must pass", advisory: "advisory", doneWhen: "Done when", generated: "Generated by script from TaskGraph." },
    validation: { valid: "✅ No validation issues.", errors: "Errors", warnings: "Warnings" },
    blueprint: { mode: "Mode", date: "Date", executiveSummary: "Executive Summary (RPI - Request Intent)", requestIntent: "Request Intent", transversalImpact: "Cross-cutting Impact", noImpact: "No collateral impact detected.", assumptions: "Assumptions and Accepted Inferences", noAssumptions: "None; the request is fully bounded.", designSpec: "Design Specification (SDD)", coreEntities: "Core Entities", noEntities: "No new entities were defined.", invariants: "Non-negotiable Invariants", standardRules: "Standard project rules.", contracts: "Data and API Contracts", noContracts: "No new explicit contracts.", testConditions: "Verification and Test Conditions", defaultTests: "Validate with the standard test suite.", taskBreakdown: "Task Breakdown Plan (GitHub Projects v2)", pendingBreakdown: "Pending breakdown in the transaction phase.", approved: "Blueprint Approved", sddEntities: "SDD Entities", assumed: "Accepted assumptions", inferences: "inferences", exactSpec: "exact specification", summary: "Summary", artifact: "Artifact", artifactsSaved: "Saved artifacts", safetyGate: "SAFETY GATE: GITHUB PROJECTS MUTATION", action: "Action", repo: "Repo", title: "Title", safetyTicket: "Safety Gate ticket (required for mutation)" },
  },
  pt: {
    common: { none: "Nenhum", noneFeminine: "Nenhuma", yes: "sim", no: "não", files: "arquivos", tests: "testes", tasks: "tarefas", generatedBy: "Gerado por mr-orchestrator" },
    coverage: { heading: "cobertura", fresh: "atualizada", reindexed: "não (reindexada)", unsupported: "não suportados", unresolvedImports: "imports não resolvidos", parseErrors: "erros de análise" },
    workspace: { title: "Mapa do Workspace Atlas", repositories: "repositórios", languages: "linguagens", nodes: "nós" },
    plan: { title: "Plano de Implementação", summary: "Resumo", rootCause: "Causa Raiz", affectedFiles: "Arquivos Afetados", noSpecificTests: "Nenhum teste específico planejado.", verification: "Verificação", file: "Arquivo", action: "Ação", risk: "Risco", reason: "Motivo", test: "Teste", type: "Tipo", description: "Descrição" },
    progress: ["Ticket", "Intenção", "Pesquisa", "Planejamento", "Implementação", "Revisão", "Revisão/Correção", "Entrega"],
    intent: { title: "Intenção, em resumo", problem: "Problema", outcome: "Resultado", signals: "Sinais de aceitação", constraints: "Restrições", next: "Próximo passo", nextDetail: "Confirme esta intenção antes de explorar o código.", proposedTitle: "Rascunho de intenção (revisar antes de explorar)", sweeps: "Varreduras executadas", assumptions: "Suposições inferidas", unresolved: "Lacunas pendentes", suggestedDefault: "Padrão sugerido", sources: "Fontes por campo", confirmProposed: "Confirme o rascunho com mr_flow_intent ou refine via mr_sdd_submit kind=intent.", needsInputTitle: "Intenção incompleta — esclarecimento excepcional" },
    flow: { title: "Status do Fluxo", progress: "Progresso", estimatedCost: "Custo estimado pelo OpenCode", tokens: "tokens entrada/saída/raciocínio", cache: "cache", sessions: "sessões", workspace: "Workspace", started: "Iniciado", difficulty: "Dificuldade", riskLane: "Faixa de risco", laneReason: "Motivo da faixa", ticket: "Ticket", titleLabel: "Título", branch: "Branch", base: "base", plan: "Plano", contextBudget: "Contexto hidratado", hydrations: "hidratações", truncated: "cortados" },
    explanation: { title: "Plano em resumo", what: "O quê", why: "Por quê", how: "Como", proof: "Prova", defaultWhy: "Cumprir os critérios de aceitação com a menor mudança segura.", taskVerification: "verificação específica de cada tarefa" },
    verdict: { title: "Veredito do Dia do Julgamento", approved: "APROVADO", rejected: "REJEITADO", summary: "Resumo", judge: "Juiz", critical: "Achados Críticos", warnings: "Avisos", suggestions: "Sugestões", verifiedEvidence: "Evidência Verificada", severity: "Severidade", finding: "Achado", location: "Local", evidence: "Evidência", merged: "Consolidado em" },
    proposal: { generated: "Proposta gerada por mr-orchestrator /propose", promptTitle: "Prompt Gerado", copied: "Copiado para a área de transferência por mr-orchestrator /prompt" },
    research: { title: "Pesquisa", objective: "Objetivo", evidence: "Evidência", reference: "Referência", source: "Fonte", storedSlice: "trecho armazenado", contracts: "Contratos", relevantNodes: "Nós Relevantes (Atlas)", constraints: "Restrições", unknowns: "Incógnitas", generated: "Gerado por script a partir de ResearchCapsule." },
    spec: { title: "Especificação", goal: "Meta", inScope: "Dentro do Escopo", outScope: "Fora do Escopo", requirements: "Requisitos e Critérios de Aceitação", risks: "Riscos", given: "Dado", when: "Quando", then: "Então", generated: "Gerado por script a partir de SpecCapsule." },
    taskGraph: { title: "Tarefas", completed: "concluídas", dependsOn: "Depende de", requirements: "Requisitos", intent: "Intenção", symbols: "Símbolos", evidence: "Evidência", allowedFiles: "Arquivos permitidos", forbiddenGlobs: "Globs proibidos", evidenced: "Com evidência", invariants: "Invariantes", verification: "Verificação", mustPass: "deve passar", advisory: "informativa", doneWhen: "Concluído quando", generated: "Gerado por script a partir de TaskGraph." },
    validation: { valid: "✅ Nenhum problema de validação.", errors: "Erros", warnings: "Avisos" },
    blueprint: { mode: "Modo", date: "Data", executiveSummary: "Resumo Executivo (RPI - Intenção da Solicitação)", requestIntent: "Intenção da Solicitação", transversalImpact: "Impacto Transversal", noImpact: "Nenhum impacto colateral detectado.", assumptions: "Suposições e Inferências Aceitas", noAssumptions: "Nenhuma; a solicitação está totalmente delimitada.", designSpec: "Especificação de Design (SDD)", coreEntities: "Entidades Core", noEntities: "Nenhuma nova entidade foi definida.", invariants: "Invariantes Não Negociáveis", standardRules: "Regras padrão do projeto.", contracts: "Contratos de Dados e APIs", noContracts: "Nenhum novo contrato explícito.", testConditions: "Condições de Verificação e Teste", defaultTests: "Validar com a suíte de testes padrão.", taskBreakdown: "Plano de Divisão em Tarefas (GitHub Projects v2)", pendingBreakdown: "Divisão pendente na fase transacional.", approved: "Blueprint Aprovado", sddEntities: "Entidades SDD", assumed: "Suposições aceitas", inferences: "inferências", exactSpec: "especificação exata", summary: "Resumo", artifact: "Artefato", artifactsSaved: "Artefatos salvos", safetyGate: "PORTÃO DE SEGURANÇA: MUTAÇÃO NO GITHUB PROJECTS", action: "Ação", repo: "Repo", title: "Título", safetyTicket: "Ticket do Safety Gate (obrigatório para mutação)" },
  },
  ca: {
    common: { none: "Cap", noneFeminine: "Cap", yes: "sí", no: "no", files: "fitxers", tests: "proves", tasks: "tasques", generatedBy: "Generat per mr-orchestrator" },
    coverage: { heading: "cobertura", fresh: "actualitzada", reindexed: "no (reindexada)", unsupported: "no compatibles", unresolvedImports: "imports sense resoldre", parseErrors: "errors d'anàlisi" },
    workspace: { title: "Mapa de l'Espai de Treball Atlas", repositories: "repositoris", languages: "llenguatges", nodes: "nodes" },
    plan: { title: "Pla d'Implementació", summary: "Resum", rootCause: "Causa Arrel", affectedFiles: "Fitxers Afectats", noSpecificTests: "No hi ha proves específiques planificades.", verification: "Verificació", file: "Fitxer", action: "Acció", risk: "Risc", reason: "Motiu", test: "Prova", type: "Tipus", description: "Descripció" },
    progress: ["Ticket", "Intenció", "Recerca", "Planificació", "Implementació", "Revisió", "Revisió/Correcció", "Lliurament"],
    intent: { title: "Intenció, en breu", problem: "Problema", outcome: "Resultat", signals: "Senyals d'acceptació", constraints: "Restriccions", next: "Següent pas", nextDetail: "Confirma aquesta intenció abans d'explorar codi.", proposedTitle: "Esborrany d'intenció (revisar abans d'explorar)", sweeps: "Barrides executades", assumptions: "Supòsits inferits", unresolved: "Buits pendents", suggestedDefault: "Valor per defecte suggerit", sources: "Fonts per camp", confirmProposed: "Confirma l'esborrany amb mr_flow_intent o refina amb mr_sdd_submit kind=intent.", needsInputTitle: "Intenció incompleta — aclariment excepcional" },
    flow: { title: "Estat del Flux", progress: "Progrés", estimatedCost: "Cost estimat per OpenCode", tokens: "tokens entrada/sortida/raonament", cache: "memòria cau", sessions: "sessions", workspace: "Espai de treball", started: "Iniciat", difficulty: "Dificultat", riskLane: "Carril de risc", laneReason: "Motiu del carril", ticket: "Ticket", titleLabel: "Títol", branch: "Branca", base: "base", plan: "Pla", contextBudget: "Context hidratat", hydrations: "hidratacions", truncated: "retallats" },
    explanation: { title: "Pla, en breu", what: "Què", why: "Per què", how: "Com", proof: "Prova", defaultWhy: "Complir els criteris d'acceptació amb el canvi segur més petit.", taskVerification: "verificació específica de cada tasca" },
    verdict: { title: "Veredicte del Dia del Judici", approved: "APROVAT", rejected: "REBUTJAT", summary: "Resum", judge: "Jutge", critical: "Troballes Crítiques", warnings: "Advertiments", suggestions: "Suggeriments", verifiedEvidence: "Evidència Verificada", severity: "Severitat", finding: "Troballa", location: "Ubicació", evidence: "Evidència", merged: "Fusionat el" },
    proposal: { generated: "Proposta generada per mr-orchestrator /propose", promptTitle: "Prompt Generat", copied: "Copiat al porta-retalls per mr-orchestrator /prompt" },
    research: { title: "Recerca", objective: "Objectiu", evidence: "Evidència", reference: "Referència", source: "Font", storedSlice: "fragment desat", contracts: "Contractes", relevantNodes: "Nodes Rellevants (Atlas)", constraints: "Restriccions", unknowns: "Incògnites", generated: "Generat per script des de ResearchCapsule." },
    spec: { title: "Especificació", goal: "Objectiu", inScope: "Dins de l'Abast", outScope: "Fora de l'Abast", requirements: "Requisits i Criteris d'Acceptació", risks: "Riscos", given: "Donat", when: "Quan", then: "Aleshores", generated: "Generat per script des de SpecCapsule." },
    taskGraph: { title: "Tasques", completed: "completades", dependsOn: "Depèn de", requirements: "Requisits", intent: "Intenció", symbols: "Símbols", evidence: "Evidència", allowedFiles: "Fitxers permesos", forbiddenGlobs: "Globs prohibits", evidenced: "Amb evidència", invariants: "Invariants", verification: "Verificació", mustPass: "ha de passar", advisory: "informativa", doneWhen: "Fet quan", generated: "Generat per script des de TaskGraph." },
    validation: { valid: "✅ Sense problemes de validació.", errors: "Errors", warnings: "Advertiments" },
    blueprint: { mode: "Mode", date: "Data", executiveSummary: "Resum Executiu (RPI - Intenció de la Sol·licitud)", requestIntent: "Intenció de la Sol·licitud", transversalImpact: "Impacte Transversal", noImpact: "No s'ha detectat cap impacte col·lateral.", assumptions: "Supòsits i Inferències Acceptades", noAssumptions: "Cap; la sol·licitud està completament delimitada.", designSpec: "Especificació de Disseny (SDD)", coreEntities: "Entitats Core", noEntities: "No s'han definit entitats noves.", invariants: "Invariants No Negociables", standardRules: "Regles estàndard del projecte.", contracts: "Contractes de Dades i APIs", noContracts: "No hi ha contractes explícits nous.", testConditions: "Condicions de Verificació i Prova", defaultTests: "Validació amb la suite de proves estàndard.", taskBreakdown: "Pla de Desglossament en Tasques (GitHub Projects v2)", pendingBreakdown: "Pendent de desglossament en la fase transaccional.", approved: "Blueprint Aprovat", sddEntities: "Entitats SDD", assumed: "Supòsits acceptats", inferences: "inferències", exactSpec: "especificació exacta", summary: "Resum", artifact: "Artefacte", artifactsSaved: "Artefactes desats", safetyGate: "PORTA DE SEGURETAT: MUTACIÓ A GITHUB PROJECTS", action: "Acció", repo: "Repo", title: "Títol", safetyTicket: "Ticket de Safety Gate (obligatori per a la mutació)" },
  },
  fr: {
    common: { none: "Aucun", noneFeminine: "Aucune", yes: "oui", no: "non", files: "fichiers", tests: "tests", tasks: "tâches", generatedBy: "Généré par mr-orchestrator" },
    coverage: { heading: "couverture", fresh: "à jour", reindexed: "non (réindexée)", unsupported: "non pris en charge", unresolvedImports: "imports non résolus", parseErrors: "erreurs d'analyse" },
    workspace: { title: "Carte de l'Espace de Travail Atlas", repositories: "dépôts", languages: "langages", nodes: "nœuds" },
    plan: { title: "Plan d'Implémentation", summary: "Résumé", rootCause: "Cause Racine", affectedFiles: "Fichiers Affectés", noSpecificTests: "Aucun test spécifique planifié.", verification: "Vérification", file: "Fichier", action: "Action", risk: "Risque", reason: "Raison", test: "Test", type: "Type", description: "Description" },
    progress: ["Ticket", "Intention", "Recherche", "Planification", "Implémentation", "Revue", "Revue/Correction", "Livraison"],
    intent: { title: "Intention, en bref", problem: "Problème", outcome: "Résultat", signals: "Signaux d'acceptation", constraints: "Contraintes", next: "Étape suivante", nextDetail: "Confirmez cette intention avant d'explorer le code.", proposedTitle: "Brouillon d'intention (à revoir avant l'exploration)", sweeps: "Balayages exécutés", assumptions: "Hypothèses inférées", unresolved: "Lacunes restantes", suggestedDefault: "Valeur par défaut suggérée", sources: "Sources par champ", confirmProposed: "Confirmez le brouillon avec mr_flow_intent ou affinez via mr_sdd_submit kind=intent.", needsInputTitle: "Intention incomplète — clarification exceptionnelle" },
    flow: { title: "État du Flux", progress: "Progression", estimatedCost: "Coût estimé par OpenCode", tokens: "tokens entrée/sortie/raisonnement", cache: "cache", sessions: "sessions", workspace: "Espace de travail", started: "Démarré", difficulty: "Difficulté", riskLane: "Niveau de risque", laneReason: "Motif du niveau", ticket: "Ticket", titleLabel: "Titre", branch: "Branche", base: "base", plan: "Plan", contextBudget: "Contexte hydraté", hydrations: "hydratations", truncated: "tronqués" },
    explanation: { title: "Plan en bref", what: "Quoi", why: "Pourquoi", how: "Comment", proof: "Preuve", defaultWhy: "Respecter les critères d'acceptation avec le plus petit changement sûr.", taskVerification: "vérification propre à chaque tâche" },
    verdict: { title: "Verdict du Jour du Jugement", approved: "APPROUVÉ", rejected: "REJETÉ", summary: "Résumé", judge: "Juge", critical: "Constats Critiques", warnings: "Avertissements", suggestions: "Suggestions", verifiedEvidence: "Preuves Vérifiées", severity: "Sévérité", finding: "Constat", location: "Emplacement", evidence: "Preuve", merged: "Fusionné le" },
    proposal: { generated: "Proposition générée par mr-orchestrator /propose", promptTitle: "Prompt Généré", copied: "Copié dans le presse-papiers par mr-orchestrator /prompt" },
    research: { title: "Recherche", objective: "Objectif", evidence: "Preuve", reference: "Référence", source: "Source", storedSlice: "extrait stocké", contracts: "Contrats", relevantNodes: "Nœuds Pertinents (Atlas)", constraints: "Contraintes", unknowns: "Inconnues", generated: "Généré par script depuis ResearchCapsule." },
    spec: { title: "Spécification", goal: "Objectif", inScope: "Dans le Périmètre", outScope: "Hors Périmètre", requirements: "Exigences et Critères d'Acceptation", risks: "Risques", given: "Étant donné", when: "Quand", then: "Alors", generated: "Généré par script depuis SpecCapsule." },
    taskGraph: { title: "Tâches", completed: "terminées", dependsOn: "Dépend de", requirements: "Exigences", intent: "Intention", symbols: "Symboles", evidence: "Preuves", allowedFiles: "Fichiers autorisés", forbiddenGlobs: "Globs interdits", evidenced: "Documenté", invariants: "Invariants", verification: "Vérification", mustPass: "doit réussir", advisory: "indicative", doneWhen: "Terminé quand", generated: "Généré par script depuis TaskGraph." },
    validation: { valid: "✅ Aucun problème de validation.", errors: "Erreurs", warnings: "Avertissements" },
    blueprint: { mode: "Mode", date: "Date", executiveSummary: "Résumé Exécutif (RPI - Intention de la Demande)", requestIntent: "Intention de la Demande", transversalImpact: "Impact Transversal", noImpact: "Aucun impact collatéral détecté.", assumptions: "Hypothèses et Inférences Acceptées", noAssumptions: "Aucune ; la demande est entièrement délimitée.", designSpec: "Spécification de Conception (SDD)", coreEntities: "Entités Principales", noEntities: "Aucune nouvelle entité définie.", invariants: "Invariants Non Négociables", standardRules: "Règles standard du projet.", contracts: "Contrats de Données et d'API", noContracts: "Aucun nouveau contrat explicite.", testConditions: "Conditions de Vérification et de Test", defaultTests: "Validation avec la suite de tests standard.", taskBreakdown: "Plan de Découpage en Tâches (GitHub Projects v2)", pendingBreakdown: "Découpage en attente dans la phase transactionnelle.", approved: "Blueprint Approuvé", sddEntities: "Entités SDD", assumed: "Hypothèses acceptées", inferences: "inférences", exactSpec: "spécification exacte", summary: "Résumé", artifact: "Artefact", artifactsSaved: "Artefacts enregistrés", safetyGate: "PASSERELLE DE SÉCURITÉ : MUTATION GITHUB PROJECTS", action: "Action", repo: "Dépôt", title: "Titre", safetyTicket: "Ticket Safety Gate (requis pour la mutation)" },
  },
} satisfies Record<UserLanguage, RenderMessages>;

export function messagesFor(language: UserLanguage | undefined): RenderMessages {
  return MESSAGES[normalizeUserLanguage(language)];
}

function renderList(items: readonly string[], empty: string): string {
  if (items.length === 0) return `- ${empty}`;
  return items.map((item) => `- ${item}`).join("\n");
}

export interface CoverageReceiptScope {
  readonly files?: readonly string[];
  readonly nodeIds?: readonly string[];
}

export function renderCoverageReceipt(
  graph: AtlasGraph,
  fresh: boolean,
  scope: CoverageReceiptScope = {},
  language: UserLanguage = "es",
): string {
  const m = messagesFor(language);
  const scopedFiles = scope.files === undefined
    ? undefined
    : new Set(scope.files);
  const relevant = (path: string): boolean => scopedFiles === undefined || scopedFiles.has(path);
  const unsupported = graph.coverage.unsupportedFiles.filter(relevant);
  const unresolved = graph.coverage.unresolvedImports.filter((item) => relevant(item.from));
  const errors = graph.coverage.parseErrors.filter((item) => relevant(item.path));
  const sample = (items: readonly string[]): string => items.length === 0 ? "0" : `${items.length} (${items.slice(0, 3).join(", ")})`;
  return [
    `--- ${m.coverage.heading} ---`,
    `${m.coverage.fresh}: ${fresh ? m.common.yes : m.coverage.reindexed}`,
    `${m.coverage.unsupported}: ${sample(unsupported)}`,
    `${m.coverage.unresolvedImports}: ${sample(unresolved.map((item) => `${item.from} → ${item.specifier}`))}`,
    `${m.coverage.parseErrors}: ${sample(errors.map((item) => `${item.path}:${item.line}`))}`,
  ].join("\n");
}

export function renderWorkspaceMap(graph: AtlasGraph, language: UserLanguage = "es"): string {
  const m = messagesFor(language);
  const repositories = new Map<string, number>();
  for (const file of graph.files) {
    const segments = file.path.split("/");
    const repo = segments[0] === "repos" && segments[1] !== undefined ? segments[1] : ".";
    repositories.set(repo, (repositories.get(repo) ?? 0) + 1);
  }
  const kinds = new Map<string, number>();
  for (const node of graph.nodes) kinds.set(node.kind, (kinds.get(node.kind) ?? 0) + 1);
  return [
    `# ${m.workspace.title}`,
    `${m.workspace.repositories}: ${[...repositories].map(([repo, count]) => `${repo} (${count} ${m.common.files})`).join(", ") || m.common.none}`,
    `${m.workspace.languages}: ${[...new Set(graph.files.map((file) => file.language))].join(", ")}`,
    `${m.workspace.nodes}: ${[...kinds].map(([kind, count]) => `${kind}=${count}`).join(", ")}`,
  ].join("\n");
}

function renderFileTable(files: PlanCapsule["files"], language: UserLanguage): string {
  const m = messagesFor(language);
  const lines = [
    `| ${m.plan.file} | ${m.plan.action} | ${m.plan.risk} | ${m.plan.reason} |`,
    "|---------|--------|--------|-------|",
  ];
  for (const file of files) {
    lines.push(`| \`${file.path}\` | ${file.action} | ${file.risk} | ${file.reason} |`);
  }
  return lines.join("\n");
}

function renderTestTable(tests: PlanCapsule["tests"], language: UserLanguage): string {
  const m = messagesFor(language);
  if (tests.length === 0) return `_${m.plan.noSpecificTests}_`;
  const lines = [
    `| ${m.plan.test} | ${m.plan.type} | ${m.plan.description} |`,
    "|------|------|-------------|",
  ];
  for (const test of tests) {
    lines.push(`| \`${test.path}\` | ${test.type} | ${test.description} |`);
  }
  return lines.join("\n");
}

export function renderPlanCapsule(plan: PlanCapsule, language: UserLanguage = "es"): string {
  const m = messagesFor(language);
  return `# ${m.plan.title} — ${plan.ticket.id}

## ${m.plan.summary}
${plan.summary}

${plan.rootCause !== undefined ? `## ${m.plan.rootCause}\n${plan.rootCause}\n` : ""}
## ${m.plan.affectedFiles}
${renderFileTable(plan.files, language)}

## ${m.common.tests}
${renderTestTable(plan.tests, language)}

## ${m.plan.verification}
- Typecheck: ${plan.verification.typecheck ? "✅" : "❌"}
- Lint: ${plan.verification.lint ? "✅" : "❌"}
- Tests: ${plan.verification.test ? "✅" : "❌"}
- Build: ${plan.verification.build ? "✅" : "❌"}

---
*${m.common.generatedBy} · ${plan.createdAt}*
`;
}

function flowProgress(state: FlowState, completed: boolean, language: UserLanguage): string {
  const m = messagesFor(language);
  const rank: Record<FlowState["phase"], number> = {
    init: 0,
    wizard: 0,
    context: 0,
    intent: 1,
    explore: 2,
    plan: 3,
    implement: 4,
    judgment: 5,
    fix: 5,
    finish: 6,
  };
  const labels = [
    m.progress[0], m.progress[1], m.progress[2], m.progress[3], m.progress[4],
    state.phase === "fix" ? m.progress[6] : m.progress[5], m.progress[7],
  ];
  return labels.map((label, index) => {
    if (index === 5 && "difficulty" in state && !requiresJudgment(state.lane ?? state.difficulty)) return `— ${label}`;
    if (index < rank[state.phase] || (index === 6 && completed)) return `✓ ${label}`;
    if (index === rank[state.phase]) return `● ${label}`;
    return `○ ${label}`;
  }).join("  →  ");
}

export function renderFlowUsage(usage: FlowUsageSummary, language: UserLanguage = "es"): string {
  const m = messagesFor(language);
  const tokens = usage.tokens;
  const tokenUsage = `**${m.flow.estimatedCost}**: $${usage.cost.toFixed(4)} USD · ${m.flow.tokens}: ${String(tokens.input)}/${String(tokens.output)}/${String(tokens.reasoning)} · ${m.flow.cache}: ${String(tokens.cacheRead)} read, ${String(tokens.cacheWrite)} write · ${String(usage.sessions)} ${m.flow.sessions}`;
  const decisions = usage.decisionPlane === undefined
    ? undefined
    : `**Jev shadow**: ${String(usage.decisionPlane.calls)} calls · ${String(usage.decisionPlane.escalations)} escalations · ${String(usage.decisionPlane.errors)} errors · ${String(usage.decisionPlane.inputTokens)}/${String(usage.decisionPlane.outputTokens)} tokens · ${String(usage.decisionPlane.latencyMs)} ms`;
  const context = usage.context === undefined
    ? undefined
    : `**${m.flow.contextBudget} (${usage.context.role}/${usage.context.lane})**: ${String(usage.context.usedChars)}/${String(usage.context.requestedChars)} chars · ${String(usage.context.hydrations)} ${m.flow.hydrations} · ${String(usage.context.truncated)} ${m.flow.truncated}`;
  return [tokenUsage, decisions, context].filter((line) => line !== undefined).join("\n");
}

export function renderFlowStatus(
  state: FlowState,
  usage?: FlowUsageSummary,
  options: {
    readonly completed?: boolean;
    readonly language?: UserLanguage;
    readonly models?: EffectiveHarnessModels;
    readonly harnessBadge?: string;
  } = {},
): string {
  const language = options.language ?? normalizeUserLanguage(state.userLanguage);
  const m = messagesFor(language);
  const badge = options.harnessBadge
    ?? (options.models === undefined ? undefined : renderFlowHarnessBadge(state, options.models));
  const lines = [
    ...(badge === undefined ? [] : [`\`${badge}\``, ""]),
    `# ${m.flow.title} — ${state.phase}`,
    "",
    `**${m.flow.progress}**: ${flowProgress(state, options.completed ?? false, language)}`,
    ...(usage === undefined ? [] : [renderFlowUsage(usage, language)]),
    "",
    `- **${m.flow.workspace}**: ${state.workspaceId}`,
    `- **${m.flow.started}**: ${state.startedAt}`,
  ];

  if ("difficulty" in state) {
    lines.push(`- **${m.flow.difficulty}**: ${state.difficulty}`);
  }
  if (state.lane !== undefined) {
    lines.push(`- **${m.flow.riskLane}**: ${state.lane}`);
    if (state.riskReasons !== undefined && state.riskReasons.length > 0) {
      lines.push(`- **${m.flow.laneReason}**: ${state.riskReasons.join("; ")}`);
    }
  }
  if ("ticket" in state) {
    lines.push(`- **${m.flow.ticket}**: ${state.ticket.ref.platform}:${state.ticket.ref.id}`);
    lines.push(`- **${m.flow.titleLabel}**: ${state.ticket.title}`);
  }
  if ("branch" in state) {
    lines.push(`- **${m.flow.branch}**: ${state.branch} (${m.flow.base}: ${state.baseBranch})`);
  }
  if ("plan" in state) {
    lines.push(`- **${m.flow.plan}**: ${state.plan.files.length} ${m.common.files}, ${state.plan.tests.length} ${m.common.tests}`);
  }
  if ("commitHash" in state && state.commitHash !== undefined) {
    lines.push(`- **Commit**: ${state.commitHash}`);
  }
  if ("prUrl" in state && state.prUrl !== undefined) {
    lines.push(`- **PR**: ${state.prUrl}`);
  }

  return lines.join("\n");
}

function compactText(value: string, max = 180): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

export function renderIntentExplanation(intent: IntentBriefPayload | IntentDisplayPayload, language: UserLanguage = "es"): string {
  const m = messagesFor(language);
  const signals = intent.acceptanceSignals.slice(0, 3).map((signal) => `- ${signal}`).join("\n");
  const extraSignals = Math.max(0, intent.acceptanceSignals.length - 3);
  return [
    `## ${m.intent.title}`,
    `- **${m.intent.problem}**: ${intent.problem}`,
    `- **${m.intent.outcome}**: ${intent.outcome}`,
    `- **${m.intent.signals}**:\n${signals}${extraSignals > 0 ? `\n- … +${String(extraSignals)}` : ""}`,
    `- **${m.intent.constraints}**: ${intent.constraints.length > 0 ? intent.constraints.join("; ") : m.common.none}`,
    `- **${m.intent.next}**: ${m.intent.nextDetail}`,
  ].join("\n");
}

export function renderIntentProposal(intent: IntentProposedPayload, sweepLog: readonly string[] = [], language: UserLanguage = "es"): string {
  const m = messagesFor(language);
  const core = renderIntentExplanation(intent, language).replace(`## ${m.intent.title}`, `## ${m.intent.proposedTitle}`);
  const sourceLines = Object.entries(intent.resolution.fields)
    .slice(0, 6)
    .map(([field, meta]) => `- \`${field}\`: ${meta.source} (${meta.confidence})`)
    .join("\n");
  const assumptionLines = intent.assumptions.length > 0
    ? intent.assumptions.map((assumption) => `- [${assumption.risk}] ${assumption.statement}`).join("\n")
    : `- ${m.common.noneFeminine}`;
  const unresolvedLines = intent.unresolved.length > 0
    ? intent.unresolved.map((gap) => {
      const defaultLine = gap.suggestedDefault === undefined ? "" : `\n  - ${m.intent.suggestedDefault}: ${gap.suggestedDefault}`;
      return `- **${gap.field}** (${gap.risk}): ${gap.reason}${defaultLine}`;
    }).join("\n")
    : `- ${m.common.noneFeminine}`;
  const sweepLines = sweepLog.map((line) => `- ${line}`).join("\n");
  return [
    core,
    `- **${m.intent.sources}**:\n${sourceLines}`,
    `- **${m.intent.assumptions}**:\n${assumptionLines}`,
    `- **${m.intent.unresolved}**:\n${unresolvedLines}`,
    sweepLines.length > 0 ? `- **${m.intent.sweeps}**:\n${sweepLines}` : "",
    `- **${m.intent.next}**: ${m.intent.confirmProposed}`,
  ].filter((line) => line.length > 0).join("\n");
}

export function renderIntentNeedsInput(intent: IntentNeedsInputPayload, sweepLog: readonly string[] = [], language: UserLanguage = "es"): string {
  const m = messagesFor(language);
  const questions = intent.questions.map((question) => {
    const options = question.options.length > 0
      ? `\n  - ${question.options.map((option) => `[${option}]`).join(" | ")}`
      : "";
    return `- **${question.id}** (${question.risk}): ${question.question}\n  - ${question.reason}${options}`;
  }).join("\n");
  const sweepLines = sweepLog.map((line) => `- ${line}`).join("\n");
  return [
    `## ${m.intent.needsInputTitle}`,
    questions,
    sweepLines.length > 0 ? `- **${m.intent.sweeps}**:\n${sweepLines}` : "",
    `- **${m.intent.next}**: Responde con mr_sdd_submit kind=intent (status=READY o PROPOSED) o vuelve a ejecutar mr_flow_intent_resolve tras aclarar.`,
  ].filter((line) => line.length > 0).join("\n");
}

export function renderIntentAssessment(assessment: IntentAssessmentPayload, sweepLog: readonly string[] = [], language: UserLanguage = "es"): string {
  if (assessment.status === "NEEDS_INPUT") return renderIntentNeedsInput(assessment, sweepLog, language);
  if (assessment.status === "PROPOSED") return renderIntentProposal(assessment, sweepLog, language);
  return renderIntentExplanation(assessment, language);
}

export function renderPlanExplanation(plan: PlanCapsule, taskCount?: number, language: UserLanguage = "es"): string {
  const m = messagesFor(language);
  const paths = plan.files.slice(0, 3).map((file) => `\`${file.path}\``).join(", ");
  const extra = Math.max(0, plan.files.length - 3);
  const checks = Object.entries(plan.verification)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name)
    .join(" + ");
  return [
    `## ${m.explanation.title}`,
    `- **${m.explanation.what}**: ${compactText(plan.summary)}`,
    `- **${m.explanation.why}**: ${compactText(plan.rootCause ?? plan.files[0]?.reason ?? m.explanation.defaultWhy)}`,
    `- **${m.explanation.how}**: ${String(taskCount ?? plan.files.length)} ${m.common.tasks}; ${String(plan.files.length)} ${m.common.files} (${paths}${extra > 0 ? ` +${String(extra)}` : ""}).`,
    `- **${m.explanation.proof}**: ${checks === "" ? m.explanation.taskVerification : checks}.`,
  ].join("\n");
}

export function buildTaskDeveloperNote(
  task: SddTask,
  requirements: readonly Requirement[],
  language: UserLanguage = "en",
): { readonly what: string; readonly why: string; readonly touch: string; readonly prove: string } {
  const m = messagesFor(language);
  const requirementWhy = requirements.map((requirement) => requirement.statement).join("; ");
  return {
    what: compactText(task.title, 120),
    why: compactText(requirementWhy === "" ? (task.doneWhen[0] ?? m.explanation.taskVerification) : requirementWhy, 180),
    touch: task.files.map((file) => file.path).join(", "),
    prove: task.verification.commands.join(" && "),
  };
}

export function renderVerdict(verdict: MergedVerdict, language: UserLanguage = "es"): string {
  const m = messagesFor(language);
  const status = verdict.approved ? `✅ ${m.verdict.approved}` : `❌ ${m.verdict.rejected}`;
  const evidenceRows = verdict.findings.map((finding) =>
    `| ${finding.severity} | ${finding.claim} | \`${finding.file}:${String(finding.line)} (${finding.side})\` | \`${finding.evidence}\` |`,
  );
  return `# ${m.verdict.title} — ${status}

## ${m.verdict.summary}
- **${m.verdict.judge} A**: ${verdict.judgeA.approved ? "✅" : "❌"} (${verdict.judgeA.judge})
- **${m.verdict.judge} B**: ${verdict.judgeB.approved ? "✅" : "❌"} (${verdict.judgeB.judge})

## ${m.verdict.critical}
${renderList(verdict.critical, m.common.none)}

## ${m.verdict.warnings}
${renderList(verdict.warnings, m.common.noneFeminine)}

## ${m.verdict.suggestions}
${renderList(verdict.suggestions, m.common.noneFeminine)}

## ${m.verdict.verifiedEvidence}
${evidenceRows.length === 0 ? m.common.noneFeminine : `| ${m.verdict.severity} | ${m.verdict.finding} | ${m.verdict.location} | ${m.verdict.evidence} |\n|-----------|----------|-----------|-----------|\n${evidenceRows.join("\n")}`}

---
*${m.verdict.merged} ${verdict.mergedAt}*
`;
}

export function renderProposal(title: string, body: string, language: UserLanguage = "es"): string {
  const m = messagesFor(language);
  return `# ${title}

${body}

---
*${m.proposal.generated}*
`;
}

export function renderPrompt(prompt: string, language: UserLanguage = "es"): string {
  const m = messagesFor(language);
  return `# ${m.proposal.promptTitle}

\`\`\`
${prompt}
\`\`\`

---
*${m.proposal.copied}*
`;
}

// ─── SDD + RPI Renderers (markdown por script, nunca por IA) ─────────────────

export function renderResearchCapsule(research: ResearchCapsulePayload, language: UserLanguage = "es"): string {
  const m = messagesFor(language);
  const evidenceRows = research.evidenceRefs.map((ref) => `| \`${ref}\` | ${m.research.storedSlice} |`);
  return `# ${m.research.title} — ${research.ticketId}

## ${m.research.objective}
${research.objective}

## ${m.research.evidence}
| ${m.research.reference} | ${m.research.source} |
|------------|--------|
${evidenceRows.join("\n")}

## ${m.coverage.heading}
- ${m.coverage.fresh}: ${research.coverage.fresh ? m.common.yes : m.common.no}
- ${m.coverage.unsupported}: ${research.coverage.unsupportedFiles.length}
- ${m.coverage.unresolvedImports}: ${research.coverage.unresolvedImports.length}

## ${m.research.contracts}
${renderList(research.contracts.map((contract) => `${contract.kind}: ${contract.name} (${contract.file})`), m.common.none)}

## ${m.common.tests}
${renderList(research.tests.map((test) => `${test.file} → ${test.covers.join(", ") || "unscoped"}`), m.common.none)}

## ${m.research.relevantNodes}
${renderList(research.relevantNodes, m.common.none)}

## ${m.research.constraints}
${renderList(research.constraints, m.common.noneFeminine)}

## ${m.research.unknowns}
${renderList(research.unknowns, m.common.noneFeminine)}

---
*${m.research.generated}*
`;
}

export function renderSpecCapsule(spec: SpecCapsulePayload, language: UserLanguage = "es"): string {
  const m = messagesFor(language);
  const requirementBlocks = spec.requirements.map((requirement) => {
    const criteria = requirement.acceptance.map((criterion) => {
      const given = criterion.given !== undefined ? `**${m.spec.given}** ${criterion.given}, ` : "";
      return `  - ${given}**${m.spec.when}** ${criterion.when}, **${m.spec.then}** ${criterion.then}`;
    });
    return `### ${requirement.id}: ${requirement.statement}\n${criteria.join("\n")}`;
  });
  return `# ${m.spec.title} — ${spec.ticketId}

## ${m.spec.goal}
${spec.goal}

## ${m.spec.inScope}
${renderList(spec.scopeIn, "—")}

## ${m.spec.outScope}
${renderList(spec.scopeOut, "—")}

## ${m.spec.requirements}
${requirementBlocks.join("\n\n")}

## ${m.spec.risks}
${renderList(spec.risks, m.common.none)}

---
*${m.spec.generated}*
`;
}

const TASK_STATUS_ICONS: Record<string, string> = {
  pending: "⬜",
  in_progress: "🔄",
  done: "✅",
  blocked: "🚫",
};

export function renderTaskGraph(tasks: TaskGraphPayload, language: UserLanguage = "es"): string {
  const m = messagesFor(language);
  const blocks = tasks.tasks.map((task) => {
    const icon = TASK_STATUS_ICONS[task.status] ?? "⬜";
    const deps = task.dependsOn.length > 0 ? task.dependsOn.join(", ") : "—";
    const fileRows = task.files.map((f) => `| \`${f.path}\` | ${f.action} | ${f.risk} | ${f.evidenced ? m.common.yes : m.common.no} | ${f.reason} |`);
    return `### ${icon} ${task.id}: ${task.title}
- **${m.taskGraph.dependsOn}**: ${deps}
- **${m.taskGraph.requirements}**: ${task.requirements.join(", ")}
- **${m.taskGraph.intent}**: ${task.changeIntent}
- **${m.taskGraph.symbols}**: ${task.targetSymbols.join(", ") || "—"}
- **${m.taskGraph.evidence}**: ${task.evidenceRefs.join(", ")}
- **${m.taskGraph.allowedFiles}**: ${task.editBoundaries.allowedFiles.join(", ")}
- **${m.taskGraph.forbiddenGlobs}**: ${task.editBoundaries.forbiddenGlobs.join(", ") || "—"}

| ${m.plan.file} | ${m.plan.action} | ${m.plan.risk} | ${m.taskGraph.evidenced} | ${m.plan.reason} |
|---------|--------|--------|-------------|-------|
${fileRows.join("\n")}

**${m.taskGraph.invariants}**:
${task.invariants.map((invariant) => `- ${invariant}`).join("\n") || "- —"}

**${m.taskGraph.verification}**: ${task.verification.commands.join(" · ")} (${task.verification.mustPass ? m.taskGraph.mustPass : m.taskGraph.advisory})
**${m.taskGraph.doneWhen}**:
${task.doneWhen.map((d) => `- ${d}`).join("\n")}`;
  });

  const doneCount = tasks.tasks.filter((t) => t.status === "done").length;
  return `# ${m.taskGraph.title} — ${tasks.ticketId} (${doneCount}/${tasks.tasks.length} ${m.taskGraph.completed})

${blocks.join("\n\n")}

---
*${m.taskGraph.generated}*
`;
}

export function renderSddIssues(issues: readonly SddValidationIssue[], language: UserLanguage = "es"): string {
  const m = messagesFor(language);
  if (issues.length === 0) return m.validation.valid;
  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  const lines: string[] = [];
  if (errors.length > 0) {
    lines.push(`## ${m.validation.errors} (${errors.length})`);
    lines.push(...errors.map((issue) => `- ❌ ${issue.message}`));
  }
  if (warnings.length > 0) {
    lines.push(`## ${m.validation.warnings} (${warnings.length})`);
    lines.push(...warnings.map((issue) => `- ⚠️ ${issue.message}`));
  }
  return lines.join("\n");
}
