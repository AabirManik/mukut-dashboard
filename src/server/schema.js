/**
 * MUKUT Telemetry Schema Validator (Version 1.0)
 * Validates incoming telemetry packets against the standard data contract.
 */

export function validateTelemetry(data) {
  const errors = [];

  if (!data || typeof data !== 'object') {
    return { valid: false, errors: ['Telemetry payload must be a non-null JSON object'] };
  }

  // Version check (allow v1.0 or absence defaulted to 1.0)
  if (data.version && typeof data.version !== 'string') {
    errors.push('Field "version" must be a string (e.g. "1.0")');
  }

  // Helmet ID check
  if (!data.helmet_id || typeof data.helmet_id !== 'string') {
    errors.push('Field "helmet_id" is required and must be a string');
  }

  // Timestamp check
  if (data.timestamp === undefined || typeof data.timestamp !== 'number') {
    errors.push('Field "timestamp" is required and must be a numeric timestamp');
  }

  // Environment check
  if (!data.environment || typeof data.environment !== 'object') {
    errors.push('Field "environment" is required and must be an object');
  } else {
    const env = data.environment;
    if (typeof env.temperature !== 'number') {
      errors.push('Field "environment.temperature" must be a number');
    }
    if (typeof env.humidity !== 'number') {
      errors.push('Field "environment.humidity" must be a number');
    }
    if (typeof env.methane !== 'number') {
      errors.push('Field "environment.methane" must be a number');
    }
    if (typeof env.carbon_monoxide !== 'number') {
      errors.push('Field "environment.carbon_monoxide" must be a number');
    }
    if (typeof env.smoke !== 'number') {
      errors.push('Field "environment.smoke" must be a number');
    }
  }

  // Safety check
  if (!data.safety || typeof data.safety !== 'object') {
    errors.push('Field "safety" is required and must be an object');
  } else {
    if (typeof data.safety.sos !== 'boolean') {
      errors.push('Field "safety.sos" must be a boolean');
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}
