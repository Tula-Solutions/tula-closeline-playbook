import pkg from '../package.json'

/** This service's name, as reported by its health endpoint and its OpenAPI document. */
export const SERVICE = 'tula-closeline-playbook'

/** This service's version, read from package.json. */
export const VERSION: string = pkg.version
