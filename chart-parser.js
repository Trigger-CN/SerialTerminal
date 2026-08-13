'use strict';

const PARSER_MODES = new Set(['key-value', 'template', 'regex']);
const FIELD_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const NUMBER_SOURCE = '[-+]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:[eE][-+]?\\d+)?';
const DEFAULT_COLORS = ['#4fc3f7', '#66bb6a', '#ffca28', '#ef5350', '#ab47bc', '#26a69a', '#ffa726', '#ec407a'];
const UNIT_FACTORS = { us: 0.000001, ms: 0.001, s: 1 };

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseScalar(rawValue) {
  const match = String(rawValue || '').trim().match(new RegExp(`^(${NUMBER_SOURCE})([%A-Za-z]+)?$`));
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  return { value, rawValue: match[1], unit: match[2] || '', type: Number.isInteger(value) ? 'int' : 'number' };
}

function convertUnit(value, sourceUnit = '', displayUnit = sourceUnit) {
  if (!Number.isFinite(value) || !sourceUnit || !displayUnit || sourceUnit === displayUnit) return value;
  if (!(sourceUnit in UNIT_FACTORS) || !(displayUnit in UNIT_FACTORS)) return value;
  return value * UNIT_FACTORS[sourceUnit] / UNIT_FACTORS[displayUnit];
}

function normalizeChartParserConfig(config = {}) {
  const mode = PARSER_MODES.has(config.mode || config.parserMode) ? (config.mode || config.parserMode) : 'key-value';
  return {
    mode,
    marker: typeof config.marker === 'string' ? config.marker : (typeof config.lineMarker === 'string' ? config.lineMarker : ''),
    keyValueSeparator: ['=', ':', 'auto'].includes(config.keyValueSeparator) ? config.keyValueSeparator : 'auto',
    template: typeof config.template === 'string' ? config.template : '',
    pattern: typeof config.pattern === 'string' ? config.pattern.slice(0, 2000) : '',
    caseInsensitive: config.caseInsensitive === true,
    fields: Array.isArray(config.fields) ? config.fields.filter(field => field && FIELD_NAME_PATTERN.test(field.key || '')).slice(0, 16).map((field, index) => ({
      key: field.key,
      label: typeof field.label === 'string' && field.label ? field.label : field.key,
      color: /^#[0-9a-f]{6}$/i.test(field.color || '') ? field.color : DEFAULT_COLORS[index % DEFAULT_COLORS.length],
      sourceUnit: typeof field.sourceUnit === 'string' ? field.sourceUnit : (typeof field.unit === 'string' ? field.unit : ''),
      displayUnit: typeof field.displayUnit === 'string' ? field.displayUnit : (typeof field.unit === 'string' ? field.unit : ''),
      precision: Math.max(0, Math.min(8, Number.isInteger(field.precision) ? field.precision : 2)),
      visible: field.visible !== false,
      role: field.role === 'sequence' ? 'sequence' : 'series'
    })) : []
  };
}

function parseKeyValues(line, config) {
  if (config.marker && !line.includes(config.marker)) return null;
  const keySource = config.keyValueSeparator === 'auto'
    ? '([A-Za-z_][A-Za-z0-9_.-]*)\\s*=|([A-Za-z_][A-Za-z0-9_]*)\\s*:'
    : `([A-Za-z_][A-Za-z0-9_.-]*)\\s*${escapeRegex(config.keyValueSeparator)}`;
  const expression = new RegExp(`(?:^|[\\s,;])(?:${keySource})\\s*([^\\s,;]+)`, 'g');
  const values = {};
  let match;
  while ((match = expression.exec(line)) !== null) {
    const key = config.keyValueSeparator === 'auto' ? (match[1] || match[2]) : match[1];
    const rawValue = config.keyValueSeparator === 'auto' ? match[3] : match[2];
    values[key] = parseScalar(rawValue) || { invalid: true, rawValue };
  }
  return Object.keys(values).length ? values : null;
}

function placeholderSource(type) {
  if (type === 'int') return '[-+]?\\d+';
  if (type === 'hex') return '(?:0[xX])?[0-9A-Fa-f]+';
  if (type === 'text') return '\\S+';
  if (type === 'time') return '\\S+';
  if (type && !['number', 'auto'].includes(type)) return `${NUMBER_SOURCE}${escapeRegex(type)}`;
  return `${NUMBER_SOURCE}(?:[%A-Za-z]+)?`;
}

function compileTemplate(template, caseInsensitive = false) {
  if (!template || template.length > 2000) throw new Error('Template is empty or too long');
  const fields = [];
  let source = '';
  let cursor = 0;
  const placeholder = /\{([A-Za-z_][A-Za-z0-9_.-]*)(?::([A-Za-z][A-Za-z0-9]*))?\}/g;
  const compileLiteral = literal => literal.split(/\s+/).map(escapeRegex).join('\\s+');
  let match;
  while ((match = placeholder.exec(template)) !== null) {
    source += compileLiteral(template.slice(cursor, match.index));
    const type = match[2] || 'auto';
    fields.push({ key: match[1], type });
    source += `(${placeholderSource(type)})`;
    cursor = match.index + match[0].length;
  }
  if (!fields.length) throw new Error('Template must contain at least one field');
  source += compileLiteral(template.slice(cursor));
  return { regex: new RegExp(source, caseInsensitive ? 'i' : ''), fields };
}

function parseTemplate(line, config, compiled = compileTemplate(config.template, config.caseInsensitive)) {
  if (config.marker && !line.includes(config.marker)) return null;
  const match = compiled.regex.exec(line);
  if (!match) return null;
  const values = {};
  compiled.fields.forEach((field, index) => {
    const raw = match[index + 1];
    if (field.type === 'text' || field.type === 'time') {
      values[field.key] = { value: raw, rawValue: raw, unit: '', type: field.type };
      return;
    }
    const numericRaw = field.type === 'hex' ? String(parseInt(raw, 16)) : raw;
    const scalar = parseScalar(numericRaw);
    if (scalar) {
      if (field.type && !['auto', 'number', 'int', 'hex'].includes(field.type)) scalar.unit = field.type;
      values[field.key] = scalar;
    }
  });
  return Object.keys(values).length ? values : null;
}

function parseRegex(line, config, regex = null) {
  if (config.marker && !line.includes(config.marker)) return null;
  const expression = regex || new RegExp(config.pattern, `${config.caseInsensitive ? 'i' : ''}u`);
  const match = expression.exec(line);
  if (!match?.groups) return null;
  const values = {};
  Object.entries(match.groups).forEach(([key, raw]) => {
    const scalar = parseScalar(raw);
    values[key] = scalar || { invalid: true, rawValue: raw };
  });
  return Object.keys(values).length ? values : null;
}

function parseCandidateValues(line, normalized, compiled = null) {
  if (normalized.mode === 'template') return parseTemplate(line, normalized, compiled);
  if (normalized.mode === 'regex') return parseRegex(line, normalized, compiled);
  return parseKeyValues(line, normalized);
}

function isIdentifierField(key) {
  return /^(?:count|index|idx|seq|sequence|id)$/i.test(key);
}

function discoverChartFields(sampleLine, config = {}) {
  const normalized = normalizeChartParserConfig(config);
  const values = parseCandidateValues(String(sampleLine || ''), normalized);
  if (!values) return [];
  return Object.entries(values).filter(([, scalar]) => !scalar.invalid).map(([key, scalar], index) => ({
    key,
    label: key.replace(/_/g, ' '),
    sampleValue: scalar.value,
    type: scalar.type,
    sourceUnit: scalar.unit,
    displayUnit: scalar.unit === 'us' ? 'ms' : scalar.unit,
    precision: 2,
    color: DEFAULT_COLORS[index % DEFAULT_COLORS.length],
    visible: scalar.type !== 'text' && scalar.type !== 'time' && !isIdentifierField(key),
    role: isIdentifierField(key) ? 'sequence' : 'series'
  }));
}

function createChartParser(config = {}) {
  const normalized = normalizeChartParserConfig(config);
  const compiled = normalized.mode === 'template'
    ? compileTemplate(normalized.template, normalized.caseInsensitive)
    : (normalized.mode === 'regex' ? new RegExp(normalized.pattern, `${normalized.caseInsensitive ? 'i' : ''}u`) : null);
  const fieldMap = new Map(normalized.fields.map(field => [field.key, field]));
  return {
    config: normalized,
    parse(line, metadata = {}) {
      const candidates = parseCandidateValues(String(line || ''), normalized, compiled);
      if (!candidates) return null;
      const values = {};
      let sequenceValue = null;
      let hasFiniteSeries = false;
      let hasInvalidSeries = false;
      fieldMap.forEach((field, key) => {
        const candidate = candidates[key];
        if (candidate?.invalid) {
          if (field.role === 'series') hasInvalidSeries = true;
          return;
        }
        if (!candidate || !Number.isFinite(candidate.value)) {
          if (field.role === 'series') values[key] = null;
          return;
        }
        if (field.role === 'sequence') {
          sequenceValue = candidate.value;
          return;
        }
        hasFiniteSeries = true;
        values[key] = convertUnit(candidate.value, field.sourceUnit || candidate.unit, field.displayUnit || field.sourceUnit || candidate.unit);
      });
      if (hasInvalidSeries || !hasFiniteSeries) return null;
      return {
        timestamp: Number.isFinite(metadata.receivedAt) ? metadata.receivedAt : Date.now(),
        sequence: metadata.sequence ?? sequenceValue,
        sourceSequence: sequenceValue,
        values
      };
    }
  };
}

module.exports = {
  DEFAULT_COLORS,
  normalizeChartParserConfig,
  discoverChartFields,
  createChartParser,
  convertUnit,
  parseScalar,
  compileTemplate
};
