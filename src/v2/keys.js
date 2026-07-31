export default class Keys {
  constructor (prefix, clusterId) {
    this.prefix = prefix
    this.base = clusterId ? `${prefix}{${clusterId}}:data:v2:` : `{${prefix}data:v2}:`
  }

  entry (id) {
    return `${this.base}entry:${id}`
  }

  body (id) {
    return `${this.base}body:${id}`
  }

  resource (resourceHash) {
    return `${this.base}resource:${resourceHash}`
  }

  all () {
    return `${this.base}index:all`
  }

  origin (originHash) {
    return `${this.base}index:origin:${originHash}`
  }

  originMethod (originMethodHash) {
    return `${this.base}index:origin-method:${originMethodHash}`
  }

  originPath (originPathHash) {
    return `${this.base}index:origin-path:${originPathHash}`
  }

  resourceIndex (resourceHash) {
    return `${this.base}index:resource:${resourceHash}`
  }

  tag (tag) {
    return `${this.base}tag:${tag}`
  }
}
