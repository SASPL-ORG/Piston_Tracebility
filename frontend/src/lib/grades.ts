// Canonical grade catalog. Single source of truth used by the Zebra
// scanner page (Packing.tsx) and the desktop Live Mirror
// (PackingMonitor.tsx) so column ordering and code/pCode mapping stays
// consistent across surfaces.

export interface GradeDef {
  code: string;
  pCode: string;
}

export interface GradeGroup {
  category: string;
  grades: GradeDef[];
}

export const GRADE_GROUPS: GradeGroup[] = [
  {
    category: 'EGR · N ISG',
    grades: [
      { code: 'A', pCode: 'P234102M100' },
      { code: 'B', pCode: 'P234102M110' },
      { code: 'C', pCode: 'P234102M120' },
    ],
  },
  {
    category: 'EGR · ISG',
    grades: [
      { code: 'AS', pCode: 'P234102M150' },
      { code: 'BS', pCode: 'P234102M160' },
      { code: 'CS', pCode: 'P234102M170' },
    ],
  },
  {
    category: 'N EGR · N ISG',
    grades: [
      { code: 'AG', pCode: 'P234102M400' },
      { code: 'BG', pCode: 'P234102M410' },
      { code: 'CG', pCode: 'P234102M420' },
    ],
  },
  {
    category: 'N EGR · ISG',
    grades: [
      { code: 'AL', pCode: 'P234102M450' },
      { code: 'BL', pCode: 'P234102M460' },
      { code: 'CL', pCode: 'P234102M470' },
    ],
  },
  {
    category: 'CNG',
    grades: [
      { code: 'AN', pCode: 'P234102MZA0' },
      { code: 'BN', pCode: 'P234102MZB0' },
      { code: 'CN', pCode: 'P234102MZC0' },
    ],
  },
];

export const ALL_GRADES: GradeDef[] = GRADE_GROUPS.flatMap((g) => g.grades);
export const GRADE_BY_PCODE = new Map(ALL_GRADES.map((g) => [g.pCode, g] as const));
export const REJECT = 'REJECT';
export const P_CODE_RE = /P234102M[0-9A-Z]{3}/;

// Model classification — collapses the ISG / N ISG sub-categories into
// the three top-level customer model lines (EGR, N EGR, CNG). Customers
// order and warehouse by model number, not by the finer sub-category,
// so this is what appears on the pallet label.
export type ModelNumber = 'EGR' | 'N EGR' | 'CNG';

export function modelOfPCode(pCode: string): ModelNumber | null {
  for (const group of GRADE_GROUPS) {
    if (group.grades.some((g) => g.pCode === pCode)) {
      const label = group.category;
      if (label.startsWith('N EGR')) return 'N EGR';
      if (label.startsWith('EGR'))   return 'EGR';
      if (label === 'CNG')           return 'CNG';
    }
  }
  return null;
}

// Hierarchical view of the same catalog — categories (EGR / N EGR / CNG)
// each split into sub-categories (ISG / N ISG / blank for CNG). Used by
// matrix-style tables (Production Summary on Lists, Packing Summary on
// Dashboard) that mirror the customer's Production Dashboard.xlsx
// template. Same grade order as GRADE_GROUPS — derived twice from the
// catalog is fine because they're presentation-only.
export interface MatrixSubCategory { label: string; grades: GradeDef[] }
export interface MatrixCategory    { label: string; subs: MatrixSubCategory[] }

export const GRADE_MATRIX: MatrixCategory[] = [
  {
    label: 'EGR',
    subs: [
      { label: 'N ISG',  grades: [GRADE_GROUPS[0].grades[0], GRADE_GROUPS[0].grades[1], GRADE_GROUPS[0].grades[2]] },
      { label: 'ISG',    grades: [GRADE_GROUPS[1].grades[0], GRADE_GROUPS[1].grades[1], GRADE_GROUPS[1].grades[2]] },
    ],
  },
  {
    label: 'N EGR',
    subs: [
      { label: 'N ISG',  grades: [GRADE_GROUPS[2].grades[0], GRADE_GROUPS[2].grades[1], GRADE_GROUPS[2].grades[2]] },
      { label: 'ISG',    grades: [GRADE_GROUPS[3].grades[0], GRADE_GROUPS[3].grades[1], GRADE_GROUPS[3].grades[2]] },
    ],
  },
  {
    label: 'CNG',
    subs: [
      { label: '',       grades: [GRADE_GROUPS[4].grades[0], GRADE_GROUPS[4].grades[1], GRADE_GROUPS[4].grades[2]] },
    ],
  },
];

export const MATRIX_CATEGORY_BG: Record<string, string> = {
  'EGR': 'bg-blue-50',
  'N EGR': 'bg-amber-50',
  'CNG': 'bg-emerald-50',
};
export const MATRIX_CATEGORY_BORDER: Record<string, string> = {
  'EGR': 'border-blue-200',
  'N EGR': 'border-amber-200',
  'CNG': 'border-emerald-200',
};

// Flattened column order for the matrix tables.
export const GRADE_MATRIX_FLAT: { grade: GradeDef; category: string }[] =
  GRADE_MATRIX.flatMap((cat) =>
    cat.subs.flatMap((sub) => sub.grades.map((g) => ({ grade: g, category: cat.label }))),
  );
