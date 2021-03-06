/**
 * turtle.io
 *
 * Easy to use web server with virtual hosts & reverse proxies
 *
 * @author Jason Mulligan <jason.mulligan@avoidwork.com>
 * @copyright 2013 Jason Mulligan
 * @license BSD-3 <https://raw.github.com/avoidwork/turtle.io/master/LICENSE>
 * @link http://turtle.io
 * @version 1.0.3
 */
"use strict";

var $             = require( "abaaso" ),
    crypto        = require( "crypto" ),
    defaultConfig = require( __dirname + "/../config.json" ),
    fs            = require( "fs" ),
    http          = require( "http" ),
    https         = require( "https" ),
    http_auth     = require( "http-auth" ),
    mime          = require( "mime" ),
    moment        = require( "moment" ),
    syslog        = require( "node-syslog" ),
    toobusy       = require( "toobusy" ),
    zlib          = require( "zlib" ),
    REGEX_BODY    = /^(put|post|patch)$/i,
    REGEX_COMP    = /javascript|json|text|xml/,
    REGEX_CSV     = /text\/csv/,
    REGEX_EXT     = /\.[\w+]{1,}$/, // 1 is for source code files, etc.
    REGEX_HEAD    = /^(head|options)$/i,
    REGEX_HEAD2   = /head|options/i,
    REGEX_GET     = /^(get|head|options)$/i,
    REGEX_DEL     = /^(del)$/i,
    REGEX_DEF     = /deflate/,
    REGEX_DIR     = /\/$/,
    REGEX_GZIP    = /gz/,
    REGEX_IE      = /msie/i,
    REGEX_JSON    = /json/,
    REGEX_NEXT    = /\..*/,
    REGEX_NVAL    = /;.*/,
    REGEX_NURI    = /.*\//,
    REGEX_RENAME  = /^rename$/,
    REGEX_SPACE   = /\s+/,
    REGEX_STREAM  = /application|audio|chemical|conference|font|image|message|model|xml|video/,
    REGEX_REWRITE;

// Hooking syslog output
syslog.init( "turtle_io", syslog.LOG_PID | syslog.LOG_ODELAY, syslog.LOG_LOCAL0 );

// Disabling abaaso observer
$.discard( true );

/**
 * TurtleIO
 *
 * @constructor
 */
function TurtleIO () {
	this.config         = {};
	this.etags          = $.lru( 1000 );
	this.handlers       = {all: {regex: [], routes: [], hosts: {}}, "delete": {regex: [], routes: [], hosts: {}}, get: {regex: [], routes: [], hosts: {}}, patch: {regex: [], routes: [], hosts: {}}, post: {regex: [], routes: [], hosts: {}}, put: {regex: [], routes: [], hosts: {}}};
	this.pages          = {all: {}};
	this.session.server = this;
	this.sessions       = {};
	this.server         = null;
	this.vhosts         = [];
	this.vhostsRegExp   = [];
	this.watching       = {};
}

// Prototype loop
TurtleIO.prototype.constructor = TurtleIO;

/**
 * Verifies a method is allowed on a URI
 *
 * @method allowed
 * @param  {String} method HTTP verb
 * @param  {String} uri    URI to query
 * @param  {String} host   Hostname
 * @return {Boolean}       Boolean indicating if method is allowed
 */
TurtleIO.prototype.allowed = function ( method, uri, host ) {
	var self   = this,
	    result = false,
	    exist  = false,
	    d, hosts;

	host  = host || "all";
	hosts = this.handlers[method].hosts;
	d     = hosts[this.config["default"]];
	exist = ( hosts[host] );

	this.handlers[method].regex.each( function ( i, idx ) {
		var route = self.handlers[method].routes[idx];

		if ( i.test( uri ) && ( ( exist && route in hosts[host] ) || route in d || route in hosts.all ) ) {
			return !( result = true );
		}
	} );

	if ( !result ) {
		hosts = this.handlers.all.hosts;
		d     = hosts[this.config["default"]];
		exist = ( hosts[host] );

		this.handlers.all.regex.each( function ( i, idx ) {
			var route = self.handlers.all.routes[idx];

			if ( i.test( uri ) && ( ( exist && route in hosts[host] ) || route in d || route in hosts.all ) ) {
				return !( result = true );
			}
		} );
	}

	return result;
};

/**
 * Determines which verbs are allowed against a URL
 *
 * @method allows
 * @param  {String} uri  URL to query
 * @param  {String} host Hostname
 * @return {String}      Allowed methods
 */
TurtleIO.prototype.allows = function ( uri, host ) {
	var self   = this,
	    verbs  = ["delete", "get", "post", "put", "patch"],
	    result;

	result = verbs.filter( function ( i ) {
		return self.allowed( i, uri, host );
	} );

	result = result.join( ", " ).toUpperCase().replace( "GET", "GET, HEAD, OPTIONS" );

	return result;
};

/**
 * Determines what authentication is valid (if any), and applies it to the request
 *
 * @method auth
 * @param  {Object}   req  Request Object
 * @param  {Object}   res  Response Object
 * @param  {String}   host Virtual host
 * @param  {Function} next Function to execute after applying optional authenication wrapper
 * @return {Object}        TurtleIO instance
 */
TurtleIO.prototype.auth = function ( req, res, host, next ) {
	// No authentication
	if ( !this.config.auth || ( this.config.auth && !this.config.auth[host] ) ) {
		next();
	}
	// Basic
	else if ( this.config.auth && this.config.auth[host] ) {
		if ( !this.config.auth[host].auth ) {
			this.config.auth[host].auth = http_auth( this.config.auth[host] );
		}

		this.config.auth[host].auth.apply( req, res, next );
	}

	return this;
};

/**
 * Creates a cipher from two input parameters
 *
 * @method cipher
 * @param  {String}  arg    String to encrypt
 * @param  {Boolean} encode [Optional] Encrypt or decrypt `arg` using `iv`, default is `true`
 * @param  {String}  iv     [Optional] Initialization vector
 * @return {String}         Result of crypto operation
 */
TurtleIO.prototype.cipher = function ( arg, encode, iv ) {
	var cipher, crypted;

	encode   = ( encode !== false );
	iv       = iv || this.config.session.iv;
	cipher   = crypto[encode ? "createCipher" : "createDecipher"]( "aes-256-cbc", iv ),
	crypted  = encode ? cipher.update( arg, "utf8", "hex" ) : cipher.update( arg, "hex", "utf8" );
	crypted += cipher.final( encode ? "hex" : "utf8" );

	return crypted;
};

/**
 * HTTP status codes
 *
 * @type {Object}
 */
TurtleIO.prototype.codes = {
	CONTINUE            : 100,
	SWITCH_PROTOCOL     : 101,
	SUCCESS             : 200,
	CREATED             : 201,
	ACCEPTED            : 202,
	NON_AUTHORITATIVE   : 203,
	NO_CONTENT          : 204,
	RESET_CONTENT       : 205,
	PARTIAL_CONTENT     : 206,
	MULTIPLE_CHOICE     : 300,
	MOVED               : 301,
	FOUND               : 302,
	SEE_OTHER           : 303,
	NOT_MODIFIED        : 304,
	USE_PROXY           : 305,
	REDIRECT            : 307,
	PERM_REDIRECT       : 308,
	BAD_REQUEST         : 400,
	UNAUTHORIZED        : 401,
	FORBIDDEN           : 403,
	NOT_FOUND           : 404,
	NOT_ALLOWED         : 405,
	NOT_ACCEPTABLE      : 406,
	PROXY_AUTH          : 407,
	REQUEST_TIMEOUT     : 408,
	CONFLICT            : 409,
	GONE                : 410,
	LENGTH_REQUIRED     : 411,
	FAILED              : 412,
	REQ_TOO_LARGE       : 413,
	URI_TOO_LONG        : 414,
	UNSUPPORTED_MEDIA   : 415,
	NOT_SATISFIABLE     : 416,
	EXPECTATION_FAILED  : 417,
	SERVER_ERROR        : 500,
	NOT_IMPLEMENTED     : 501,
	BAD_GATEWAY         : 502,
	SERVICE_UNAVAILABLE : 503,
	GATEWAY_TIMEOUT     : 504,
	HTTP_NOT_SUPPORTED  : 505
};

/**
 * Pipes compressed asset to Client
 *
 * @method compressed
 * @param  {Object}  req  HTTP(S) request Object
 * @param  {Object}  res  HTTP(S) response Object
 * @param  {Object}  body Response body
 * @param  {Object}  type gzip (gz) or deflate (df)
 * @param  {String}  etag Etag
 * @param  {Boolean} file Indicates `body` is a file path
 * @return {Objet}        TurtleIO instance
 */
TurtleIO.prototype.compress = function ( req, res, body, type, etag, file ) {
	var self    = this,
	    method  = REGEX_GZIP.test( type ) ? "createGzip" : "createDeflate",
	    sMethod = method.replace( "create", "" ).toLowerCase(),
	    fp      = this.config.tmp + "/" + etag + "." + type;

	fs.exists( fp, function ( exist ) {
		if ( exist ) {
			// Pipe compressed asset to Client
			fs.createReadStream( fp ).on( "error", function () {
				self.error( req, res, self.codes.SERVER_ERROR );
			} ).pipe( res );
		}
		else if ( !file ) {
			// Pipe Stream through compression to Client & disk
			if ( typeof body.pipe === "function" ) {
				body.pipe( zlib[method]() ).pipe( res );
				body.pipe( zlib[method]() ).pipe( fs.createWriteStream( fp ) );
			}
			// Raw response body, compress and send to Client & disk
			else {
				zlib[sMethod]( body, function ( e, data ) {
					if ( e ) {
						self.log( e );
						self.unregister( req.parsed.href );
						self.error( req, res, self.codes.SERVER_ERROR );
					}
					else {
						res.end( data );

						fs.writeFile( fp, data, "utf8", function ( e ) {
							if ( e ) {
								self.log( e );
								self.unregister( req.parsed.href );
							}
						} );
					}
				} );
			}
		}
		else {
			// Pipe compressed asset to Client
			fs.createReadStream( body ).on( "error", function ( e ) {
				self.log( e );
				self.unregister( req.parsed.href );
				self.error( req, res, self.codes.SERVER_ERROR );
			} ).pipe( zlib[method]() ).pipe( res );

			// Pipe compressed asset to disk
			fs.createReadStream( body ).on( "error", function ( e ) {
				self.log( e );
			} ).pipe( zlib[method]() ).pipe( fs.createWriteStream( fp ) );
		}
	} );

	return this;
};


/**
 * Determines what/if compression is supported for a request
 *
 * @method compression
 * @param  {String} agent    User-Agent header value
 * @param  {String} encoding Accept-Encoding header value
 * @param  {String} mimetype Mime type of response body
 * @return {Mixed}           Supported compression or null
 */
TurtleIO.prototype.compression = function ( agent, encoding, mimetype ) {
	var result    = null,
	    encodings = typeof encoding === "string" ? encoding.explode() : [];

	if ( REGEX_COMP.test( mimetype ) && this.config.compress === true && !REGEX_IE.test( agent ) ) {
		// Iterating supported encodings
		encodings.each( function ( i ) {
			if ( REGEX_GZIP.test( i ) ) {
				result = "gz";
			}
			else if ( REGEX_DEF.test( i ) ) {
				result = "zz";
			}

			// Found a supported encoding
			if ( result !== null ) {
				return false;
			}
		} );
	}

	return result;
};

/**
 * Cookies
 *
 * @class cookie
 */
TurtleIO.prototype.cookie = {
	/**
	 * Expires a cookie if it exists
	 *
	 * @method expire
	 * @param  {Object}  res    HTTP(S) response Object
	 * @param  {String}  name   Name of the cookie to expire
	 * @param  {String}  domain [Optional] Domain to set the cookie for
	 * @param  {Boolean} secure [Optional] Make the cookie only accessible via SSL
	 * @param  {String}  path   [Optional] Path the cookie is for
	 * @return {String}        Name of the expired cookie
	 */
	expire : function ( res, name, domain, secure, path ) {
		return $.cookie.expire( name, domain, secure, path, res );
	},

	/**
	 * Gets a cookie from the request headers
	 *
	 * @method get
	 * @param  {Object} req  HTTP(S) request Object
	 * @param  {String} name Name of the cookie to get
	 * @return {Mixed}       Cookie or undefined
	 */
	get : function ( req, name ) {
		return this.list( req )[name];
	},

	/**
	 * Gets a list cookies from the request headers
	 *
	 * @method list
	 * @param  {Object} req  HTTP(S) request Object
	 * @param  {String} name Cookie name
	 * @return {Object}      Collection of cookies
	 */
	list : function ( req ) {
		return $.cookie.list( req.headers.cookie || "" );
	},

	/**
	 * Sets a cookie in the response headers
	 *
	 * @method set
	 * @param  {Object}  res    HTTP(S) response Object
	 * @param  {String}  name   Name of the cookie to create
	 * @param  {String}  value  Value to set
	 * @param  {String}  offset A positive or negative integer followed by "d", "h", "m" or "s"
	 * @param  {String}  domain [Optional] Domain to set the cookie for
	 * @param  {Boolean} secure [Optional] Make the cookie only accessible via SSL
	 * @param  {String}  path   [Optional] Path the cookie is for
	 * @return {Undefined}      undefined
	 */
	set : function ( res, name, value, offset, domain, secure, path ) {
		return $.cookie.set( name, value, offset, domain, secure, path, res );
	}
};

/**
 * Encodes `arg` as JSON if applicable
 *
 * @method encode
 * @param  {Mixed} arg Object to encode
 * @return {Mixed}     Original Object or JSON string
 */
TurtleIO.prototype.encode = function ( arg ) {
	// Do not want to coerce this Object to a String!
	if ( arg instanceof Buffer || typeof arg.pipe === "function" ) {
		return arg;
	}
	// Converting to JSON
	else if ( arg instanceof Array || arg instanceof Object ) {
		return $.encode( arg );
	}
	// Nothing to do, leave it as it is
	else {
		return arg;
	}
};

/**
 * Error handler for requests
 *
 * @method error
 * @param  {Object} req    Request Object
 * @param  {Object} res    Response Object
 * @param  {Number} status [Optional] HTTP status code
 * @return {Object}        TurtleIO instance
 */
TurtleIO.prototype.error = function ( req, res, status ) {
	var method = req.method.toLowerCase(),
	    host   = req.parsed.hostname,
	    body;

	if ( isNaN( status ) ) {
		status = this.codes.NOT_FOUND;

		// If valid, determine what kind of error to respond with
		if ( !REGEX_GET.test( method ) && !REGEX_HEAD.test( method ) ) {
			if ( this.allowed( method, req.url, host ) ) {
				status = this.codes.SERVER_ERROR;
			}
			else {
				status = this.codes.NOT_ALLOWED;
			}
		}
	}

	body = this.page( status, host );

	return this.respond( req, res, body, status, {"Cache-Control": "no-cache", "Content-Length": body.length} );
};

/**
 * Generates an Etag
 *
 * @method etag
 * @param  {String} url      URL requested
 * @param  {Number} size     Response size
 * @param  {Number} modified Modified time
 * @param  {Object} body     [Optional] Response body
 * @return {String}          Etag value
 */
TurtleIO.prototype.etag = function ( /*url, size, modified, body*/ ) {
	return this.hash( $.array.cast( arguments ).join( "-" ) );
};

/**
 * Handles the request
 *
 * @method handle
 * @param  {Object}  req   HTTP(S) request Object
 * @param  {Object}  res   HTTP(S) response Object
 * @param  {String}  path  File path
 * @param  {String}  url   Requested URL
 * @param  {Boolean} dir   `true` is `path` is a directory
 * @param  {Object}  stat  fs.Stat Object
 * @return {Object}        TurtleIO instance
 */
TurtleIO.prototype.handle = function ( req, res, path, url, dir, stat ) {
	var self   = this,
	    allow  = this.allows( req.parsed.pathname, req.parsed.hostname ),
	    write  = allow.indexOf( dir ? "POST" : "PUT" ) > -1,
	    del    = allow.indexOf( "DELETE" ) > -1,
	    method = req.method,
	    cached, etag, headers, mimetype, modified, size;

	// File request
	if ( !dir ) {
		if ( REGEX_GET.test( method ) ) {
			mimetype = mime.lookup( path );
			cached   = this.etags.cache[url];
			size     = stat.size;
			modified = stat.mtime.toUTCString();
			etag     = "\"" + this.etag( url, size, stat.mtime ) + "\"";
			headers  = {Allow: allow, "Content-Length": size, "Content-Type": mimetype, Etag: etag, "Last-Modified": modified};

			if ( method === "GET" ) {
				// Decorating path for watcher
				req.path = path;

				// Client has current version
				if ( ( req.headers["if-none-match"] === etag ) || ( !req.headers["if-none-match"] && Date.parse( req.headers["if-modified-since"] ) >= stat.mtime ) ) {
					this.respond( req, res, this.messages.NO_CONTENT, this.codes.NOT_MODIFIED, headers );
				}
				// Sending current version
				else {
					this.respond( req, res, path, this.codes.SUCCESS, headers, true );
				}
			}
			else {
				this.respond( req, res, this.messages.NO_CONTENT, this.codes.SUCCESS, headers );
			}
		}
		else if ( method === "DELETE" && del ) {
			this.unregister( this.url( req ) );

			fs.unlink( path, function ( e ) {
				if ( e ) {
					self.error( req, req, self.codes.SERVER_ERROR );
				}
				else {
					self.respond( req, res, self.messages.NO_CONTENT, self.codes.NO_CONTENT, {} );
				}
			} );
		}
		else if ( method === "PUT" && write ) {
			this.write( req, res, path );
		}
		else {
			this.error( req, req, this.codes.SERVER_ERROR );
		}
	}
	// Directory request
	else {
		if ( ( method === "POST" || method === "PUT" ) && write ) {
			this.write( req, res, path );
		}
		else if ( method === "DELETE" && del ) {
			this.unregister( req.parsed.href );

			fs.unlink( path, function ( e ) {
				if ( e ) {
					self.error( req, req, self.codes.SERVER_ERROR );
				}
				else {
					self.respond( req, res, self.messages.NO_CONTENT, self.codes.NO_CONTENT, {} );
				}
			} );
		}
		else {
			this.error( req, req, this.codes.NOT_ALLOWED );
		}
	}

	return this;
};

/**
 * Sets a handler
 *
 * @method handler
 * @param  {String}   method HTTP method
 * @param  {String}   route  RegExp pattern
 * @param  {Function} fn     Handler
 * @param  {String}   host   [Optional] Virtual host, default is `all`
 * @return {Object}          TurtleIO instance
 */
TurtleIO.prototype.handler = function ( method, route, fn, host ) {
	host = host || "all";

	if ( this.handlers.all.hosts[host] === undefined ) {
		this.host( host );
	}

	this.handlers[method].routes.push( route );
	this.handlers[method].regex.push( new RegExp( "^" + route + "$" ) );
	this.handlers[method].hosts[host][route] = fn;

	return this;
};

/**
 * Creates a hash of arg
 *
 * @method hash
 * @param  {Mixed}  arg     String or Buffer
 * @param  {String} encrypt [Optional] Type of encryption
 * @param  {String} digest  [Optional] Type of digest
 * @return {String}         Hash of arg
 */
TurtleIO.prototype.hash = function ( arg, encrypt, digest ) {
	encrypt = encrypt || "md5";
	digest  = digest  || "hex";

	if ( typeof arg !== "string" && !arg instanceof Buffer ) {
		arg = "";
	}

	return crypto.createHash( encrypt ).update( arg ).digest( digest );
};

/**
 * Sets response headers
 *
 * @method headers
 * @param  {Object}  rHeaders Response headers
 * @param  {Number}  status   HTTP status code, default is 200
 * @param  {Boolean} get      Indicates if responding to a GET
 * @return {Object}           Response headers
 */
TurtleIO.prototype.headers = function ( rHeaders, status, get ) {
	var headers = $.clone( this.config.headers, true );

	// Decorating response headers
	if ( rHeaders instanceof Object ) {
		$.merge( headers, rHeaders );
	}

	// Fixing `Allow` header
	if ( !REGEX_HEAD2.test( headers.Allow ) ) {
		headers.Allow = headers.Allow.toUpperCase().explode().filter( function ( i ) {
			return !REGEX_HEAD.test( i );
		} ).join( ", " ).replace( "GET", "GET, HEAD, OPTIONS" );
	}

	if ( !headers.Date ) {
		headers.Date = new Date().toUTCString();
	}

	if ( headers["Access-Control-Allow-Methods"].isEmpty() ) {
		headers["Access-Control-Allow-Methods"] = headers.Allow;
	}

	// Decorating "Expires" header
	if ( !headers.Expires && headers["Cache-Control"] && !$.regex.no.test( headers["Cache-Control"] ) && !$.regex.priv.test( headers["Cache-Control"] ) && $.regex.number_present.test( headers["Cache-Control"] ) ) {
		headers.Expires = new Date( new Date( new Date().getTime() + $.number.parse( $.regex.number_present.exec( headers["Cache-Control"] )[0], 10 ) * 1000 ) ).toUTCString();
	}

	// Decorating "Transfer-Encoding" header
	if ( !headers["Transfer-Encoding"] )  {
		headers["Transfer-Encoding"] = "identity";
	}

	// Removing headers not wanted in the response
	if ( !get || status >= this.codes.BAD_REQUEST ) {
		delete headers["Cache-Control"];
		delete headers.Expires;
		delete headers["Last-Modified"];
	}
	else if ( status === this.codes.NOT_MODIFIED ) {
		delete headers["Last-Modified"];
	}

	if ( status === this.codes.NOT_FOUND ) {
		headers.Allow = "";
		headers["Access-Control-Allow-Methods"] = "";
	}

	if ( headers["Last-Modified"] !== undefined && headers["Last-Modified"].isEmpty() ) {
		delete headers["Last-Modified"];
	}

	return headers;
};

/**
 * Registers a virtual host
 *
 * @method host
 * @param  {String} arg Virtual host
 * @return {Object}     TurtleIO instance
 */
TurtleIO.prototype.host = function ( arg ) {
	if ( this.handlers.all.hosts[arg] === undefined ) {
		this.vhosts.push( arg );
		this.vhostsRegExp.push( new RegExp( "^" + arg.replace( /\*/g, ".*" ) + "$" ) );
		this.handlers.all.hosts[arg]       = {};
		this.handlers["delete"].hosts[arg] = {};
		this.handlers.get.hosts[arg]       = {};
		this.handlers.patch.hosts[arg]     = {};
		this.handlers.post.hosts[arg]      = {};
		this.handlers.put.hosts[arg]       = {};
	}

	return this;
};

/**
 * Logs a message
 *
 * @method log
 * @param  {Mixed} msg Error Object or String
 * @return {Object}    TurtleIO instance
 */
TurtleIO.prototype.log = function ( msg ) {
	var e = msg instanceof Error;

	if ( this.config.logs.stdout ) {
		if ( e ) {
			msg = msg.stack || msg.message || msg;
			console.error( msg );
		}
		else {
			console.log( msg );
		}
	}

	syslog.log( syslog[!e ? "LOG_INFO" : "LOG_ERR"], msg );

	return this;
};

/**
 * HTTP (semantic) status messages
 *
 * @type {Object}
 */
TurtleIO.prototype.messages = {
	SUCCESS             : "Successful",
	CREATED             : "Created",
	ACCEPTED            : "Accepted",
	NO_CONTENT          : null,
	BAD_REQUEST         : "Invalid arguments",
	UNAUTHORIZED        : "Invalid authorization or OAuth token",
	FORBIDDEN           : "Forbidden",
	NOT_FOUND           : "Not found",
	NOT_ALLOWED         : "Method not allowed",
	CONFLICT            : "Conflict",
	SERVER_ERROR        : "Server error",
	BAD_GATEWAY         : "Bad gateway",
	SERVICE_UNAVAILABLE : "Service is unavailable"
};

/**
 * Gets an HTTP status page
 *
 * @method page
 * @param  {Number} code HTTP status code
 * @param  {String} host Virtual hostname
 * @return {String}      Response body
 */
TurtleIO.prototype.page = function ( code, host ) {
	host = host && this.pages[host] ? host : "all";

	return this.pages[host][code] || this.pages[host]["500"] || this.pages.all["500"];
};

/**
 * Preparing log message
 *
 * @method prep
 * @param  {Object} req HTTP(S) request Object
 * @param  {Object} res HTTP(S) response Object
 * @return {String}     Log message
 */
TurtleIO.prototype.prep = function ( req, res ) {
	var msg    = this.config.logs.format,
	    time   = this.config.logs.time,
	    header = req.headers.authorization || "",
	    token  = header.split( REGEX_SPACE ).pop()  || "",
	    auth   = new Buffer( token, "base64" ).toString(),
	    user   = auth.split( ":" )[0] || "-",
	    refer  = req.headers.referer ? ( "\"" + req.headers.referer + "\"" ) : "-",
	    ip     = req.headers["x-forwarded-for"] ? req.headers["x-forwarded-for"].explode().last() : req.connection.remoteAddress;

	msg = msg.replace( "{{host}}",       req.headers.host )
	         .replace( "{{time}}",       moment().format( time ) )
	         .replace( "{{ip}}",         ip )
	         .replace( "{{method}}",     req.method )
	         .replace( "{{path}}",       req.parsed.path )
	         .replace( "{{status}}",     res.statusCode )
	         .replace( "{{length}}",     res.getHeader( "Content-Length" ) || "-")
	         .replace( "{{referer}}",    refer )
	         .replace( "{{user}}",       user )
	         .replace( "{{user-agent}}", req.headers["user-agent"] || "-" );

	return msg;
};

/**
 * Proxies a URL to a route
 *
 * @method proxy
 * @param  {String}  route  Route to proxy
 * @param  {String}  origin Host to proxy (e.g. http://hostname)
 * @param  {String}  host   [Optional] Hostname this route is for (default is all)
 * @param  {Boolean} stream [Optional] Stream response to client (default is false)
 * @return {Object}         TurtleIO instance
 */
TurtleIO.prototype.proxy = function ( route, origin, host, stream ) {
	var self  = this,
	    verbs = ["delete", "get", "post", "put", "patch"];

	/**
	 * Response handler
	 *
	 * @method handle
	 * @private
	 * @param  {Object} req HTTP(S) request Object
	 * @param  {Object} res HTTP(S) response Object
	 * @param  {Mixed}  arg Proxy response
	 * @param  {Object} xhr XmlHttpRequest
	 * @return {Undefined}  undefined
	 */
	function handle ( req, res, arg, xhr ) {
		var etag          = "",
		    regex         = /("|')\/[^?\/]/g,
		    regex_quote   = /^("|')/,
		    regexOrigin   = new RegExp( origin, "g" ),
		    replace       = "$1" + route,
		    url           = req.parsed.href,
		    delay         = $.expires,
		    get           = req.method === "GET",
		    rewriteOrigin = req.parsed.protocol + "//" + req.parsed.host + route,
		    resHeaders, rewrite;

		resHeaders        = headers( xhr.getAllResponseHeaders() );
		resHeaders.Server = self.config.headers.Server;

		// Something went wrong
		if ( xhr.status < self.codes.CONTINUE ) {
			self.respond( req, res, self.page( self.codes.BAD_GATEWAY, req.parsed.hostname ), self.codes.BAD_GATEWAY, resHeaders );
		}
		else {
			if ( get && ( xhr.status === self.codes.SUCCESS || xhr.status === self.codes.NOT_MODIFIED ) && !$.regex.no.test( resHeaders["Cache-Control"] ) && !$.regex.priv.test( resHeaders["Cache-Control"] ) ) {
				// Determining how long rep is valid
				if ( resHeaders["Cache-Control"] && $.regex.number_present.test( resHeaders["Cache-Control"] ) ) {
					delay = $.number.parse( $.regex.number_present.exec( resHeaders["Cache-Control"] )[0], 10 );
				}
				else if ( resHeaders.Expires !== undefined ) {
					delay = new Date( resHeaders.Expires ).diff( new Date() );
				}

				if ( delay > 0 ) {
					// Removing from LRU when invalid
					$.delay( function () {
						self.unregister( url );
					}, delay, url );
				}
			}

			if ( xhr.status !== self.codes.NOT_MODIFIED ) {
				rewrite = REGEX_REWRITE.test( ( resHeaders["Content-Type"] || "" ).replace( REGEX_NVAL, "" ) );

				// Setting headers
				if ( get && xhr.status === self.codes.SUCCESS ) {
					etag = resHeaders.Etag || "\"" + self.etag( url, resHeaders["Content-Length"] || 0, resHeaders["Last-Modified"] || 0, self.encode( arg ) ) + "\"";

					if ( resHeaders.Etag !== etag ) {
						resHeaders.Etag = etag;
					}
				}

				if ( resHeaders.Allow === undefined || resHeaders.Allow.isEmpty() ) {
					resHeaders.Allow = resHeaders["Access-Control-Allow-Methods"] || "GET";
				}

				// Determining if a 304 response is valid based on Etag only (no timestamp is kept)
				if ( get && req.headers["if-none-match"] === etag ) {
					self.respond( req, res, self.messages.NO_CONTENT, self.codes.NOT_MODIFIED, resHeaders );
				}
				else {
					if ( REGEX_HEAD.test( req.method.toLowerCase() ) ) {
						arg = self.messages.NO_CONTENT;
					}
					// Fixing root path of response
					else if ( rewrite ) {
						if ( arg instanceof Array || arg instanceof Object ) {
							arg = $.encode( arg ).replace( regexOrigin, rewriteOrigin );

							if ( route !== "/" ) {
								arg = arg.replace( /"(\/[^?\/]\w+)\//g, "\"" + route + "$1/" );
							}

							arg = $.decode( arg );
						}
						else if ( typeof arg === "string" ) {
							arg = arg.replace( regexOrigin, rewriteOrigin );

							if ( route !== "/" ) {
								arg = arg.replace( regex, replace + ( arg.match( regex ) || [""] )[0].replace( regex_quote, "" ) );
							}
						}
					}

					self.respond( req, res, arg, xhr.status, resHeaders );
				}
			}
			else {
				self.respond( req, res, arg, xhr.status, resHeaders );
			}
		}
	}

	/**
	 * Capitalizes HTTP headers
	 *
	 * @method headers
	 * @private
	 * @param  {Object} args Response headers
	 * @return {Object}      Reshaped response headers
	 */
	function headers ( args ) {
		var result = {};

		if ( !args.isEmpty() ) {
			args.trim().split( "\n" ).each( function ( i ) {
				var header, value;

				value          = i.replace( $.regex.header_value_replace, "" );
				header         = i.replace( $.regex.header_replace, "" );
				header         = header.unhyphenate( true ).replace( /\s+/g, "-" );
				result[header] = !isNaN( value ) ? Number( value ) : value;
			} );
		}

		return result;
	}

	/**
	 * Wraps the proxy request
	 *
	 * @method wrapper
	 * @private
	 * @param  {Object} req HTTP(S) request Object
	 * @param  {Object} res HTTP(S) response Object
	 * @return {Undefined}  undefined
	 */
	function wrapper ( req, res ) {
		var url      = origin + ( route !== "/" ? req.url.replace( new RegExp( "^" + route ), "" ) : req.url ),
		    method   = req.method.toLowerCase(),
		    headerz  = $.clone( req.headers, true ),
		    parsed   = $.parse( url ),
		    mimetype = mime.lookup( parsed.pathname ),
		    fn, options, proxyReq;

		// Facade to handle()
		fn = function ( arg, xhr ) {
			handle( req, res, arg, xhr );
		};

		// Streaming formats that do not need to be rewritten
		if ( !stream && ( REGEX_EXT.test( parsed.pathname ) && !REGEX_JSON.test( mimetype ) ) && REGEX_STREAM.test( mimetype ) ) {
			stream = true;
		}

		// Stripping existing authorization header because it's not relevant for the remote system
		delete headerz.authorization;

		// Identifying proxy behavior
		headerz["x-host"]             = parsed.host;
		headerz["x-forwarded-for"]    = ( headerz["x-forwarded-for"] ? headerz["x-forwarded-for"] + ", " : "" ) + req.connection.remoteAddress;
		headerz["x-forwarded-proto"]  = parsed.protocol.replace( ":", "" );
		headerz["x-forwarded-server"] = self.config.headers.Server;

		// Streaming response to Client
		if ( stream ) {
			headerz.host = req.headers.host;

			options = {
				headers  : headerz,
				hostname : parsed.hostname,
				method   : req.method,
				path     : parsed.path,
				port     : parsed.port || 80
			};

			if ( !parsed.auth.isEmpty() ) {
				options.auth = parsed.auth;
			}

			proxyReq = http.request( options, function ( proxyRes ) {
				res.writeHeader(proxyRes.statusCode, proxyRes.headers);
				proxyRes.pipe( res );
			} );

			proxyReq.on( "error", function () {
				self.respond( req, res, self.page( self.codes.BAD_GATEWAY, parsed.hostname ), self.codes.BAD_GATEWAY );
			} );

			if ( REGEX_BODY.test( req.method ) ) {
				proxyReq.write( req.body );
			}

			proxyReq.end();
		}
		// Acting as a RESTful proxy
		else {
			// Removing support for compression so the response can be rewritten (if textual)
			delete headerz["accept-encoding"];

			if ( REGEX_BODY.test( req.method ) ) {
				url[method]( fn, fn, req.body, headerz );
			}
			else if ( REGEX_DEL.test( method ) ) {
				url.del( fn, fn, headerz );
			}
			else if ( REGEX_HEAD.test( method ) ) {
				if ( method === "head" ) {
					method = "headers";
				}

				url[method]( fn, fn );
			}
			else {
				url.get( fn, fn, headerz );
			}
		}
	}

	stream = ( stream === true );

	// Setting route
	verbs.each( function ( i ) {
		if ( route === "/" ) {
			self[i]( "/.*", wrapper, host );
		}
		else {
			self[i]( route, wrapper, host );
			self[i]( route + "/.*", wrapper, host );
		}
	} );

	return this;
};
/**
 * Redirects GETs for a route to another URL
 *
 * @method redirect
 * @param  {String}  route     Route to redirect
 * @param  {String}  url       URL to redirect the Client to
 * @param  {String}  host      [Optional] Hostname this route is for (default is all)
 * @param  {Boolean} permanent [Optional] `true` will indicate the redirection is permanent
 * @return {Object}            instance
 */
TurtleIO.prototype.redirect = function ( route, url, host, permanent ) {
	var code    = this.codes[permanent === true ? "MOVED" : "REDIRECT"],
	    pattern = new RegExp( "^" + route + "$" );

	this.get( route, function ( req, res ) {
		var rewrite = ( pattern.exec( req.url ) || [] ).length > 0;

		this.respond( req, res, this.messages.NO_CONTENT, code, {"Location": ( rewrite ? req.url.replace( pattern, url ) : url )} );
	}, host);

	return this;
};

/**
 * Registers an Etag in the LRU cache
 *
 * @method register
 * @param  {String}  url   URL requested
 * @param  {Object}  state Object describing state `{etag: $etag, mimetype: $mimetype}`
 * @param  {Boolean} stale [Optional] Remove cache from disk
 * @return {Object}        TurtleIO instance
 */
TurtleIO.prototype.register = function ( url, state, stale ) {
	var cached;

	// Removing stale cache from disk
	if ( stale === true ) {
		cached = this.etags.cache[url];

		if ( cached && cached.value.etag !== state.etag ) {
			this.unregister( url );
		}
	}

	// Updating LRU
	this.etags.set( url, state );

	return this;
};

/**
 * Request handler which provides RESTful CRUD operations
 *
 * @method request
 * @public
 * @param  {Object} req  HTTP(S) request Object
 * @param  {Object} res  HTTP(S) response Object
 * @param  {String} host [Optional] Virtual host
 * @return {Object}      TurtleIO instance
 */
TurtleIO.prototype.request = function ( req, res, host ) {
	var self    = this,
	    method  = req.method,
	    handled = false,
	    found   = false,
	    count, path, nth, root;

	// Can't find the hostname in vhosts, try the default (if set) or send a 500
	if ( !host || !( host in this.config.vhosts ) ) {
		this.vhostsRegExp.each( function ( i, idx ) {
			if ( i.test( req.host ) ) {
				found = true;
				host  = self.vhosts[idx];
				return false;
			}
		} );

		if ( !found ) {
			if ( this.config["default"] !== null ) {
				host = this.config["default"];
			}
			else {
				this.error( req, res, self.codes.SERVER_ERROR );
			}
		}
	}

	// Preparing file path
	root = this.config.root + "/" + this.config.vhosts[host];
	path = ( root + req.parsed.pathname ).replace( REGEX_DIR, "" );

	// Determining if the request is valid
	fs.lstat( path, function ( e, stats ) {
		if ( e ) {
			self.error( req, res, self.codes.NOT_FOUND );
		}
		else if ( !stats.isDirectory() ) {
			self.handle( req, res, path, req.parsed.href, false, stats );
		}
		else if ( REGEX_GET.test( method ) && !REGEX_DIR.test( req.url ) ) {
			self.respond( req, res, self.messages.NO_CONTENT, self.codes.REDIRECT, {"Location": req.parsed.href + "/"} );
		}
		else if ( !REGEX_GET.test( method ) ) {
			self.handle( req, res, path, req.parsed.href, true );
		}
		else {
			count = 0;
			nth   = self.config.indexes;
			path += "/";

			self.config.index.each( function ( i ) {
				fs.lstat( path + i, function ( e, stats ) {
					if ( !e && !handled ) {
						handled = true;
						self.handle( req, res, path + i, req.parsed.href + i, false, stats );
					}
					else if ( ++count === nth && !handled ) {
						self.error( req, res, self.codes.NOT_FOUND );
					}
				} );
			} );
		}
	} );

	return this;
};

/**
 * Send a response
 *
 * @method respond
 * @param  {Object}  req     Request Object
 * @param  {Object}  res     Response Object
 * @param  {Mixed}   body    Primitive, Buffer or Stream
 * @param  {Number}  status  [Optional] HTTP status, default is `200`
 * @param  {Object}  headers [Optional] HTTP headers
 * @param  {Boolean} file    [Optional] Indicates `body` is a file path
 * @return {Object}          TurtleIO instance
 */
TurtleIO.prototype.respond = function ( req, res, body, status, headers, file ) {
	var self     = this,
	    ua       = req.headers["user-agent"],
	    encoding = req.headers["accept-encoding"],
	    type;

	status  = status || this.codes.SUCCESS;
	headers = this.headers( headers || {"Content-Type": "text/plain"}, status, req.method === "GET" );
	file    = ( file === true );

	if ( !headers.Allow ) {
		headers["Access-Control-Allow-Methods"] = headers.Allow = this.allows( req.parsed.pathname, req.parsed.hostname );
	}

	if ( body ) {
		body = this.encode( body );

		// Ensuring JSON has proper mimetype
		if ( $.regex.json_wrap.test( body ) ) {
			headers["Content-Type"] = "application/json";
		}

		if ( req.method === "GET" ) {
			// CSV hook
			if ( status === this.codes.SUCCESS && body && headers["Content-Type"] === "application/json" && req.headers.accept && REGEX_CSV.test( req.headers.accept.explode()[0].replace( REGEX_NVAL, "" ) ) ) {
				headers["Content-Type"] = "text/csv";

				if ( !headers["Content-Disposition"] ) {
					headers["Content-Disposition"] = "attachment; filename=\"" + req.url.replace( REGEX_NURI, "" ) + ".csv\"";
				}

				body = $.json.csv( body );
			}
		}
	}

	if ( req.method === "GET" && ( status === this.codes.SUCCESS || status === this.codes.NOT_MODIFIED ) ) {
		// Ensuring an Etag
		if ( !headers.Etag ) {
			headers.Etag = "\"" + this.etag( req.parsed.href, body.length || 0, headers["Last-Modified"] || 0, body || 0 ) + "\"";
		}

		// Updating cache
		if ( !$.regex.no.test( headers["Cache-Control"] ) && !$.regex.priv.test( headers["Cache-Control"] ) ) {
			this.register( req.parsed.href, {etag: headers.Etag.replace( /"/g, "" ), mimetype: headers["Content-Type"]}, true );
		}

		// Setting a watcher on the local path
		if ( req.path ) {
			this.watch( req.parsed.href, req.path, headers["Content-Type"] );
		}
	}

	// Determining if response should be compressed
	if ( status === this.codes.SUCCESS && body && this.config.compress && ( type = this.compression( ua, encoding, headers["Content-Type"] ) ) && type !== null ) {
		headers["Content-Encoding"]  = REGEX_GZIP.test( type ) ? "gzip" : "deflate";
		headers["Transfer-Encoding"] = "chunked";
		res.writeHead( status, headers );
		this.compress( req, res, body, type, headers.Etag.replace( /"/g, "" ), file );
	}
	else if ( file ) {
		headers["Transfer-Encoding"] = "chunked";
		res.writeHead( status, headers );
		fs.createReadStream( body ).on( "error", function ( e ) {
			self.log( e );
			self.error( req, res, self.codes.SERVER_ERROR );
		} ).pipe( res );
	}
	else {
		if ( body instanceof Buffer ) {
			headers["Content-Length"] = Buffer.byteLength( body.toString() );
		}
		else if ( typeof body === "string" ) {
			headers["Content-Length"] = Buffer.byteLength( body );
		}

		res.writeHead( status, headers );
		res.end( body );
	}

	return this.log( this.prep( req, res ) );
};

/**
 * Restarts the instance
 *
 * @method restart
 * @return {Object} TurtleIO instance
 */
TurtleIO.prototype.restart = function () {
	var config = this.config;

	this.stop().start( config );

	return this;
};

/**
 * Routes a request to a handler
 *
 * @method route
 * @param  {Object} req Request Object
 * @param  {Object} res Response Object
 * @return {Object}     TurtleIO instance
 */
TurtleIO.prototype.route = function ( req, res ) {
	var self   = this,
	    url    = this.url( req ),
	    parsed = $.parse( url ),
	    method = req.method.toLowerCase(),
	    cached, handler, host, payload, route;

	/**
	 * Operation
	 *
	 * @method op
	 * @private
	 * @return {Undefined} undefined
	 */
	function op () {
		if ( handler ) {
			req.cookies = {};
			req.session = null;

			// Decorating valid cookies
			if ( req.headers.cookie !== undefined ) {
				req.headers.cookie.explode( ";" ).map( function ( i ) {
					return i.split( "=" );
				} ).each( function ( i ) {
					req.cookies[i[0]] = i[1];
				} );
			}

			// Decorates a session
			if ( req.cookies[self.config.session.id] ) {
				req.session = self.session.get( req, res );
			}

			// Setting listeners if expecting a body
			if ( REGEX_BODY.test( method ) ) {
				req.setEncoding( "utf-8" );

				req.on( "data", function ( data ) {
					payload = payload === undefined ? data : payload + data;
				} );

				req.on( "end", function () {
					req.body = payload;
					handler.call( self, req, res, host );
				} );
			}
			// Looking in LRU cache for Etag
			else if ( REGEX_GET.test( method ) ) {
				cached = self.etags.get( url );

				// Sending a 304 if Client is making a GET & has current representation
				if ( cached && !REGEX_HEAD.test( method ) && req.headers["if-none-match"] && req.headers["if-none-match"].replace( /\"/g, "" ) === cached.etag ) {
					self.respond( req, res, self.messages.NO_CONTENT, self.codes.NOT_MODIFIED, {"Content-Type": cached.mimetype, Etag: "\"" + cached.etag + "\""} );
				}
				else {
					handler.call( self, req, res, host );
				}
			}
			else {
				handler.call( self, req, res, host );
			}
		}
		else {
			self.error( req, res );
		}
	}

	// Decorating parsed Object on request
	req.parsed = parsed;

	// Finding a matching vhost
	this.vhostsRegExp.each( function ( i, idx ) {
		if ( i.test( parsed.hostname ) ) {
			return !( host = self.vhosts[idx] );
		}
	} );

	if ( !host ) {
		host = this.config["default"] || "all";
	}

	if ( REGEX_HEAD.test( method ) ) {
		method = "get";
	}

	// Looking for a match
	this.handlers[method].regex.each( function ( i, idx ) {
		var x = self.handlers[method].routes[idx];

		if ( ( x in self.handlers[method].hosts[host] || x in self.handlers[method].hosts.all ) && i.test( parsed.pathname ) ) {
			route   = i;
			handler = self.handlers[method].hosts[host][x] || self.handlers[method].hosts.all[x];
			return false;
		}
	} );

	// Looking for a match against generic routes
	if ( !route ) {
		this.handlers.all.regex.each( function ( i, idx ) {
			var x = self.handlers.all.routes[idx];

			if ( ( x in self.handlers.all.hosts[host] || x in self.handlers.all.hosts.all ) && i.test( parsed.pathname ) ) {
				route   = i;
				handler = self.handlers.all.hosts[host][x] || self.handlers.all.hosts.all[x];
				return false;
			}
		} );
	}

	// Handling authentication
	this.auth( req, res, host, op );

	return this;
};

/**
 * Session factory
 *
 * @method Session
 * @constructor
 * @param {String} id     Session ID
 * @param {Object} server Server instance
 */
function Session ( id, server ) {
	this._id        = id;
	this._server    = server;
	this._timestamp = 0;
}

// Setting constructor loop
Session.prototype.constructor = Session;

/**
 * Sessions
 *
 * @class sessions
 * @type {Object}
 * @todo too slow!
 */
TurtleIO.prototype.session = {
	/**
	 * Creates a session
	 *
	 * @method create
	 * @param  {Object} req HTTP(S) request Object
	 * @param  {Object} res HTTP(S) response Object
	 * @return {Object}     Session instance
	 */
	create : function ( req, res ) {
		var instance = this.server,
		    expires  = instance.session.expires,
		    domain   = req.parsed.host.isDomain() && !req.parsed.host.isIP() ? req.parsed.host : undefined,
		    secure   = ( req.parsed.protocol === "https:" ),
		    id       = $.uuid( true ),
		    iv, sesh, sid;

		 iv   = req.connection.remoteAddress + "-" + instance.config.session.iv;
		 sesh = this.server.sessions[id] = new Session( id, this.server );
		 sid  = instance.cipher( id, true, iv );

		instance.cookie.set( res, instance.config.session.id, sid, expires, domain, secure, "/" );

		 return sesh;
	},

	/**
	 * Destroys a session
	 *
	 * @method destroy
	 * @param  {Object} req HTTP(S) request Object
	 * @param  {Object} res HTTP(S) response Object
	 * @return {Object}     TurtleIO instance
	 */
	destroy : function ( req, res ) {
		var instance = this.server,
		    domain   = req.parsed.host.isDomain() && !req.parsed.host.isIP() ? req.parsed.host : undefined,
		    secure   = ( req.parsed.protocol === "https:" ),
		    iv       = req.connection.remoteAddress + "-" + instance.config.session.iv,
		    sid      = req.cookies[instance.config.session.id],
		    id       = instance.cipher( sid, false, iv );

		if ( id ) {
			instance.cookie.expire( res, instance.config.session.id, domain, secure, "/" );
			delete instance.sessions[id];
		}

		return instance;
	},

	/**
	 * Gets a session
	 *
	 * @method get
	 * @param  {Object} req HTTP(S) request Object
	 * @param  {Object} res HTTP(S) response Object
	 * @return {Mixed}      Session or undefined
	 */
	get : function ( req, res ) {
		var instance = this.server,
		    sid      = req.cookies[instance.config.session.id],
		    sesh     = null,
		    id, iv;

		if ( sid !== undefined ) {
			iv   = req.connection.remoteAddress + "-" + instance.config.session.iv;
			id   = instance.cipher( sid, false, iv );
			sesh = instance.sessions[id] || null;

			if ( sesh !== null ) {
				if ( sesh._timestamp.diff( moment().utc().unix() ) > 1 ) {
					this.save( req, res );
				}
			}
			else {
				this.destroy( req, res );
			}
		}

		return sesh;
	},

	/**
	 * Saves a session
	 *
	 * @method save
	 * @param  {Object} req HTTP(S) request Object
	 * @param  {Object} res HTTP(S) response Object
	 * @return {Object}     TurtleIO instance
	 */
	save : function ( req, res ) {
		var instance = this.server,
		    expires  = instance.session.expires,
		    domain   = req.parsed.host.isDomain() && !req.parsed.host.isIP() ? req.parsed.host : undefined,
		    secure   = ( req.parsed.protocol === "https:" ),
		    iv       = req.connection.remoteAddress + "-" + instance.config.session.iv,
		    sid      = req.cookies[instance.config.session.id],
		    id       = instance.cipher( sid, false, iv );

		if ( id ) {
			instance.sessions[id]._timestamp = moment().unix();
			instance.cookie.set( res, instance.config.session.id, sid, expires, domain, secure, "/" );
		}

		return instance;
	},

	// Transformed `config.session.valid` for $.cookie{}
	expires : "",

	// Determines if a session has expired
	maxDiff : 0,

	// Set & unset from `start()` & `stop()`
	server : null
};

/**
 * Starts the instance
 *
 * @method start
 * @param  {Object}   config Configuration
 * @param  {Function} err    Error handler
 * @return {Object}          TurtleIO instance
 */
TurtleIO.prototype.start = function ( cfg, err ) {
	var self = this,
	    config, pages;

	config = $.clone( defaultConfig );

	// Merging custom with default config
	$.merge( config, cfg || {} );

	// Overriding default error handler
	if ( typeof err === "function" ) {
		this.error = err;
	}

	// Setting configuration
	if ( !config.port ) {
		config.port = 8000;
	}

	this.config = config;
	pages       = this.config.pages ? ( this.config.root + this.config.pages ) : ( __dirname + "/../pages" );

	// Looking for required setting
	if ( !this.config["default"] ) {
		this.log( new Error( "Invalid default virtual host" ) );
		process.exit( 1 );
	}

	// Setting session iv
	if ( this.config.session.iv === null ) {
		this.config.session.iv = crypto.randomBytes( 256 ).toString();
	}

	// Setting `Server` HTTP header
	if ( !this.config.headers.Server ) {
		this.config.headers.Server = "turtle.io/1.0.3 (abaaso/" + $.version + " node.js/" + process.versions.node.replace( /^v/, "" ) + process.platform.capitalize() + " V8/" + process.versions.v8.toString().trim() + ")";
	}

	// Creating REGEX_REWRITE
	REGEX_REWRITE = new RegExp( "^(" + this.config.proxy.rewrite.join( "|" ) + ")$" );

	// Setting acceptable lag
	toobusy.maxLag( this.config.lag );

	// Setting default routes
	this.host( "all" );

	// Registering virtual hosts
	$.array.cast( config.vhosts, true ).each( function ( i ) {
		self.host( i );
	} );

	// Setting a default GET route
	if ( !this.handlers.get.routes.contains( ".*" ) ) {
		this.get( "/.*", function ( req, res, host ) {
			this.request( req, res, host );
		}, "all" );
	}

	// Loading default error pages
	fs.readdir( pages, function ( e, files ) {
		if ( e ) {
			console.log( e );
		}
		else {
			files.each( function ( i ) {
				self.pages.all[i.replace( REGEX_NEXT, "" )] = fs.readFileSync( pages + "/" + i, "utf8" );
			} );

			// Starting server
			if ( self.server === null ) {
				if ( config.ssl.cert !== null && config.ssl.key !== null ) {
					// Reading files
					config.ssl.cert = fs.readFileSync( config.ssl.cert );
					config.ssl.key  = fs.readFileSync( config.ssl.key );

					// Starting server
					self.server = https.createServer( $.merge( config.ssl, {port: config.port, host: config.address} ), function ( req, res ) {
						self.route( req, res );
					} ).listen( config.port, config.address );
				}
				else {
					self.server = http.createServer( function ( req, res ) {
						self.route( req, res );
					} ).listen( config.port, config.address );
				}
			}
			else {
				self.server.listen( config.port, config.address );
			}

			// Dropping process
			if ( self.config.uid && !isNaN( self.config.uid ) ) {
				process.setuid( self.config.uid );
			}

			console.log( "Started turtle.io on port " + config.port );
		}
	} );

	// For toobusy()
	process.on( "uncaughtException", function ( e ) {
		self.log( e.stack || e );
	} );

	return this;
};

/**
 * Returns an Object describing the instance's status
 *
 * @method status
 * @public
 * @return {Object} Status
 */
TurtleIO.prototype.status = function () {
	var ram    = process.memoryUsage(),
	    uptime = process.uptime(),
	    state  = {config: {}, process: {}, server: {}},
	    invalid = /^(auth|session|ssl)$/;

	// Startup parameters
	$.iterate( this.config, function ( v, k ) {
		if ( !invalid.test( k ) ) {
			state.config[k] = v;
		}
	} );

	// Process information
	state.process = {
		memory : ram,
		pid    : process.pid
	};

	// Server information
	state.server = {
		address     : this.server.address(),
		uptime      : uptime
	};

	return state;
};

/**
 * Stops the instance
 *
 * @method stop
 * @return {Object} TurtleIO instance
 */
TurtleIO.prototype.stop = function () {
	var port = this.config.port;

	this.config       = {};
	this.etags        = $.lru( 1000 );
	this.handlers     = {all: {regex: [], routes: [], hosts: {}}, "delete": {regex: [], routes: [], hosts: {}}, get: {regex: [], routes: [], hosts: {}}, patch: {regex: [], routes: [], hosts: {}}, post: {regex: [], routes: [], hosts: {}}, put: {regex: [], routes: [], hosts: {}}};
	this.pages        = {all: {}};
	this.sessions     = {};
	this.server       = null;
	this.vhosts       = [];
	this.vhostsRegExp = [];
	this.watching     = {};

	if ( this.server !== null ) {
		this.server.close();
	}

	console.log( "Stopped turtle.io on port " + port );

	return this;
};

/**
 * Unregisters an Etag in the LRU cache and
 * removes stale representation from disk
 *
 * @method unregister
 * @param  {String} url URL requested
 * @return {Object}     TurtleIO instance
 */
TurtleIO.prototype.unregister = function ( url ) {
	var self   = this,
	    cached = this.etags.cache[url],
	    path   = this.config.tmp + "/",
	    gz, df;

	if ( cached ) {
		this.etags.remove( url );

		path += cached.value.etag;
		gz    = path + ".gz";
		df    = path + ".zz";

		fs.exists( gz, function ( exists ) {
			if ( exists ) {
				fs.unlink( gz, function ( e ) {
					if ( e ) {
						self.log( e );
					}
				} );
			}
		} );

		fs.exists( df, function ( exists ) {
			if ( exists ) {
				fs.unlink( df, function ( e ) {
					if ( e ) {
						self.log( e );
					}
				} );
			}
		} );
	}

	return this;
};

/**
 * Constructs a URL
 *
 * @method url
 * @param  {Object} req Request Object
 * @return {String}     Requested URL
 */
TurtleIO.prototype.url = function ( req ) {
	return "http" + ( this.config.ssl.cert ? "s" : "" ) + "://" + req.headers.host + req.url;
};

/**
 * Sets a DELETE handler
 *
 * @method delete
 * @param  {String}   route RegExp pattern
 * @param  {Function} fn    Handler
 * @param  {String}   host  [Optional] Virtual host, default is `all`
 * @return {Object}         TurtleIO instance
 */
TurtleIO.prototype["delete"] = function ( route, fn, host ) {
	var self = this;

	function op () {
		fn.apply( self, arguments );
	}

	return this.handler( "delete", route, op, host );
};

/**
 * Sets a GET handler
 *
 * @method delete
 * @param  {String}   route RegExp pattern
 * @param  {Function} fn    Handler
 * @param  {String}   host  [Optional] Virtual host, default is `all`
 * @return {Object}         TurtleIO instance
 */
TurtleIO.prototype.get = function ( route, fn, host ) {
	var self = this;

	function op () {
		fn.apply( self, arguments );
	}

	return this.handler( "get", route, op, host );
};

/**
 * Sets a PATCH handler
 *
 * @method delete
 * @param  {String}   route RegExp pattern
 * @param  {Function} fn    Handler
 * @param  {String}   host  [Optional] Virtual host, default is `all`
 * @return {Object}         TurtleIO instance
 */
TurtleIO.prototype.patch = function ( route, fn, host ) {
	var self = this;

	function op () {
		fn.apply( self, arguments );
	}

	return this.handler( "patch", route, op, host );
};

/**
 * Sets a POST handler
 *
 * @method delete
 * @param  {String}   route RegExp pattern
 * @param  {Function} fn    Handler
 * @param  {String}   host  [Optional] Virtual host, default is `all`
 * @return {Object}         TurtleIO instance
 */
TurtleIO.prototype.post = function ( route, fn, host ) {
	var self = this;

	function op () {
		fn.apply( self, arguments );
	}

	return this.handler( "post", route, op, host );
};

/**
 * Sets a PUT handler
 *
 * @method delete
 * @param  {String}   route RegExp pattern
 * @param  {Function} fn    Handler
 * @param  {String}   host  [Optional] Virtual host, default is `all`
 * @return {Object}         TurtleIO instance
 */
TurtleIO.prototype.put = function ( route, fn, host ) {
	var self = this;

	function op () {
		fn.apply( self, arguments );
	}

	return this.handler( "put", route, op, host );
};

/**
 * Watches `path` for changes & updated LRU
 *
 * @method watcher
 * @param  {String} url      LRUItem url
 * @param  {String} path     File path
 * @param  {String} mimetype Mimetype of URL
 * @return {Object}          TurtleIO instance
 */
TurtleIO.prototype.watch = function ( url, path, mimetype ) {
	var self = this,
	    watcher;

	/**
	 * Cleans up caches
	 *
	 * @method cleanup
	 * @private
	 * @return {Undefined} undefined
	 */
	function cleanup () {
		watcher.close();
		self.unregister( url );
		delete self.watching[path];
	}

	if ( !( this.watching[path] ) ) {
		// Tracking
		this.watching[path] = 1;

		// Watching path for changes
		watcher = fs.watch( path, function ( ev ) {
			if ( REGEX_RENAME.test( ev ) ) {
				cleanup();
			}
			else {
				fs.lstat( path, function ( e, stat ) {
					if ( e ) {
						self.log( e );
						cleanup();
					}
					else if ( self.etags.cache[url] ) {
						self.register( url, {etag: self.etag( url, stat.size, stat.mtime ), mimetype: mimetype}, true );
					}
					else {
						cleanup();
					}
				} );
			}
		} );
	}

	return this;
};

/**
 * Writes files to disk
 *
 * @method write
 * @param  {Object} req  HTTP request Object
 * @param  {Object} res  HTTP response Object
 * @param  {String} path File path
 * @return {Object}      TurtleIO instance
 */
TurtleIO.prototype.write = function ( req, res, path ) {
	var self  = this,
	    put   = ( req.method === "PUT" ),
	    body  = req.body,
	    allow = this.allows( req.url ),
	    del   = this.allowed( "DELETE", req.url ),
	    status;

	if ( !put && $.regex.endslash.test( req.url ) ) {
		status = del ? this.codes.CONFLICT : this.codes.SERVER_ERROR;
		this.respond( req, res, this.page( status, this.hostname( req ) ), status, {Allow: allow}, false );
	}
	else {
		allow = allow.explode().remove( "POST" ).join( ", " );

		fs.lstat( path, function ( e, stat ) {
			if ( e ) {
				self.error( req, res, self.codes.NOT_FOUND );
			}
			else {
				var etag = "\"" + self.etag( req.parsed.href, stat.size, stat.mtime ) + "\"";

				if ( !req.headers.hasOwnProperty( "etag" ) || req.headers.etag === etag ) {
					fs.writeFile( path, body, function ( e ) {
						if ( e ) {
							self.error( req, req, self.codes.SERVER_ERROR );
						}
						else {
							status = put ? self.codes.NO_CONTENT : self.codes.CREATED;
							self.respond( req, res, self.page( status, self.hostname( req ) ), status, {Allow: allow}, false );
						}
					} );
				}
				else if ( req.headers.etag !== etag ) {
					self.respond( req, res, self.messages.NO_CONTENT, self.codes.FAILED, {}, false );
				}
			}
		} );
	}

	return this;
};

module.exports = TurtleIO;
