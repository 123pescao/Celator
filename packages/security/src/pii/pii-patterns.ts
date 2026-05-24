/**
 * Low-level PII detection patterns for Celator.
 *
 * Design rules:
 * - Phone detection REQUIRES at least one separator (hyphen, dot, or space) between digit groups.
 *   This prevents false-positives on Unix timestamps, CUIDs, or other numeric sequences.
 * - Email detection requires a complete @domain.tld structure.
 * - DOB detection requires the calendar-date format YYYY-MM-DD (ISO 8601).
 * - Hashes, UUIDs, CUIDs, semver strings, and timestamps do NOT match any pattern here.
 */

// Email: must have local@domain.tld structure
export const EMAIL_PATTERN = /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/;

// Phone: requires explicit separator between each digit group — prevents timestamp false-positives
// Matches: 555-123-4567, 555.123.4567, 555 123 4567, +1-555-123-4567
// Does NOT match: 5551234567, 1699999999 (timestamps), 999177947 (semver digits)
export const PHONE_WITH_SEPARATOR_PATTERN =
  /\b(\+?1[-.\s])?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/;

// SSN: always hyphen-separated in US format XXX-XX-XXXX
export const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/;

// DOB: ISO 8601 calendar date — year must be 1900–2099 to avoid matching timestamps
export const DOB_PATTERN = /\b(19|20)\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/;

// -------------------------------------------------------------------------
// Known PII field name keys (case-insensitive match against lowercased key)
// -------------------------------------------------------------------------

export const PII_FIELD_NAMES: ReadonlySet<string> = new Set([
  'email',
  'emailaddress',
  'phone',
  'phonenumber',
  'mobilenumber',
  'telephone',
  'address',
  'streetaddress',
  'addressline1',
  'addressline2',
  'city',
  'dob',
  'dateofbirth',
  'birthdate',
  'birthyear',
  'ssn',
  'socialsecuritynumber',
  'fullname',
  'firstname',
  'lastname',
  'givenname',
  'familyname',
  'middlename',
  'governmentid',
  'passportnumber',
  'licensenumber',
  'nationalid',
  'taxpayerid',
  'tin',
  'ein',
]);

// -------------------------------------------------------------------------
// Known credential/secret field names — never allowed in audit metadata
// -------------------------------------------------------------------------

export const CREDENTIAL_FIELD_NAMES: ReadonlySet<string> = new Set([
  'password',
  'passwordhash',
  'secret',
  'privatekey',
  'secretkey',
  'accesstoken',
  'refreshtoken',
  'token',
  'apikey',
  'authtoken',
  'clientsecret',
  'bearertoken',
  'jwt',
  'oauthtoken',
  'sessiontoken',
  'csrftoken',
]);
