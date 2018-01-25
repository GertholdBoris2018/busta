var assert = require('assert');
var uuid = require('uuid');
var config = require('../config/config');

var async = require('async');
var lib = require('./lib');
var pg = require('pg');
var passwordHash = require('password-hash');
var speakeasy = require('speakeasy');
var m = require('multiline');

var databaseUrl = config.DATABASE_URL;

if (!databaseUrl)
    throw new Error('must set DATABASE_URL environment var');

console.log('DATABASE_URL: ', databaseUrl);

pg.types.setTypeParser(20, function(val) { // parse int8 as an integer
    return val === null ? null : parseInt(val);
});

// callback is called with (err, client, done)
function connect(callback) {
    return pg.connect(databaseUrl, callback);
}

function query(query, params, callback) {
    //third parameter is optional
    if (typeof params == 'function') {
        callback = params;
        params = [];
    }

    doIt();
    function doIt() {
        connect(function(err, client, done) {
            if (err) return callback(err);
            client.query(query, params, function(err, result) {
                done();
                if (err) {
                    if (err.code === '40P01') {
                        console.log('Warning: Retrying deadlocked transaction: ', query, params);
                        return doIt();
                    }
                    return callback(err);
                }

                callback(null, result);
            });
        });
    }
}

exports.query = query;

pg.on('error', function(err) {
    console.error('POSTGRES EMITTED AN ERROR', err);
});


// runner takes (client, callback)

// callback should be called with (err, data)
// client should not be used to commit, rollback or start a new transaction

// callback takes (err, data)

function getClient(runner, callback) {
    doIt();

    function doIt() {
        connect(function (err, client, done) {
            if (err) return callback(err);

            function rollback(err) {
                client.query('ROLLBACK', done);

                if (err.code === '40P01') {
                    console.log('Warning: Retrying deadlocked transaction..');
                    return doIt();
                }

                callback(err);
            }

            client.query('BEGIN', function (err) {
                if (err)
                    return rollback(err);

                runner(client, function (err, data) {
                    if (err)
                        return rollback(err);

                    client.query('COMMIT', function (err) {
                        if (err)
                            return rollback(err);

                        done();
                        callback(null, data);
                    });
                });
            });
        });
    }
}

exports.addAccessLog = function (ipAddress, userAgent, callback) {
    query('INSERT INTO accesses (ip_address, user_agent) VALUES ($1, $2)', [ipAddress, userAgent], function(err, res) {
        if(err) return callback(err);
        callback(null);
    });
}
//Returns a sessionId
exports.createUser = function(username, password, bankName, accountNumber, bankAccountName, mobilePhoneNumber, ipAddress, userAgent, domain, callback) {
    assert(username && password);

    var currentBalance = 1000000;

    getClient(
        function(client, callback) {
            var hashedPassword = passwordHash.generate(password);

            client.query('SELECT COUNT(*) count FROM users WHERE lower(username) = lower($1)', [username],
                function(err, data) {
                    if (err) return callback(err);
                    assert(data.rows.length === 1);
                    if (data.rows[0].count > 0)
                        return callback('USERNAME_TAKEN');

                    client.query('INSERT INTO users(username, password, bank_name, account_number, bank_account_name, mobile_phone_number, balance_satoshis, domain) VALUES($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
                            [username, hashedPassword, bankName, accountNumber, bankAccountName, mobilePhoneNumber, currentBalance, domain],
                            function(err, data) {
                                if (err)  {
                                    if (err.code === '23505')
                                        return callback('USERNAME_TAKEN');
                                    else
                                        return callback(err);
                                }

                                assert(data.rows.length === 1);
                                var user = data.rows[0];

                                createSession(client, user.id, ipAddress, userAgent, false, callback);
                            }
                        );

                    });
        }
    , callback);
};

exports.updateEmail = function(userId, email, callback) {
    assert(userId);

    query('UPDATE users SET email = $1 WHERE id = $2', [email, userId], function(err, res) {
        if(err) return callback(err);

        assert(res.rowCount === 1);
        callback(null);
    });

};

exports.changeUserPassword = function(userId, password, callback) {
    assert(userId && password && callback);
    var hashedPassword = passwordHash.generate(password);
    query('UPDATE users SET password = $1 WHERE id = $2', [hashedPassword, userId], function(err, res) {
        if (err) return callback(err);
        assert(res.rowCount === 1);
        callback(null);
    });
};

exports.updateMfa = function(userId, secret, callback) {
    assert(userId);
    query('UPDATE users SET mfa_secret = $1 WHERE id = $2', [secret, userId], callback);
};

// Possible errors:
//   NO_USER, WRONG_PASSWORD, INVALID_OTP
exports.validateUser = function(username, password, otp, callback) {
    assert(username && password);

    query('SELECT id, password, mfa_secret, userclass, confirmed FROM users WHERE lower(username) = lower($1)', [username], function (err, data) {
        if (err) return callback(err);

        if (data.rows.length === 0)
            return callback('NO_USER');

        var user = data.rows[0];

        var verified = passwordHash.verify(password, user.password);
        if (!verified)
            return callback('WRONG_PASSWORD');

        if (user.mfa_secret) {
            if (!otp) return callback('INVALID_OTP'); // really, just needs one

            var expected = speakeasy.totp({ key: user.mfa_secret, encoding: 'base32' });

            if (otp !== expected)
                return callback('INVALID_OTP');
        }

        callback(null, user.id, user.userclass, user.confirmed);
    });
};

/** Expire all the not expired sessions of an user by id **/
exports.expireSessionsByUserId = function(userId, callback) {
    assert(userId);

    query('UPDATE sessions SET expired = now() WHERE user_id = $1 AND expired > now()', [userId], callback);
};


function createSession(client, userId, ipAddress, userAgent, remember, callback) {
    var sessionId = uuid.v4();

    var expired = new Date();
    if (remember)
        expired.setFullYear(expired.getFullYear() + 10);
    else
        expired.setDate(expired.getDate() + 21);

    client.query('INSERT INTO sessions(id, user_id, ip_address, user_agent, expired) VALUES($1, $2, $3, $4, $5) RETURNING id',
        [sessionId, userId, ipAddress, userAgent, expired], function(err, res) {
        if (err) return callback(err);
        assert(res.rows.length === 1);

        var session = res.rows[0];
        assert(session.id);

        callback(null, session.id, expired);
    });
}

exports.createOneTimeToken = function(userId, ipAddress, userAgent, callback) {
    assert(userId);
    var id = uuid.v4();

    query('INSERT INTO sessions(id, user_id, ip_address, user_agent, ott) VALUES($1, $2, $3, $4, true) RETURNING id', [id, userId, ipAddress, userAgent], function(err, result) {
        if (err) return callback(err);
        assert(result.rows.length === 1);

        var ott = result.rows[0];

        callback(null, ott.id);
    });
};

exports.createSession = function(userId, ipAddress, userAgent, remember, callback) {
    assert(userId && callback);

    getClient(function(client, callback) {
        createSession(client, userId, ipAddress, userAgent, remember, callback);
    }, callback);

};

exports.getUserFromUsername = function(username, callback) {
    assert(username && callback);

    query('SELECT * FROM users_view WHERE lower(username) = lower($1)', [username], function(err, data) {
        if (err) return callback(err);

        if (data.rows.length === 0)
            return callback('NO_USER');

        assert(data.rows.length === 1);
        var user = data.rows[0];
        assert(typeof user.balance_satoshis === 'number');

        callback(null, user);
    });
};

exports.getUsersFromEmail = function(email, callback) {
    assert(email, callback);

    query('select * from users where email = lower($1)', [email], function(err, data) {
       if (err) return callback(err);

        if (data.rows.length === 0)
            return callback('NO_USERS');

        callback(null, data.rows);

    });
};

exports.getUserFromId = function(userId, callback) {
    query('SELECT * FROM users WHERE id = $1', [parseInt(userId)], function(err, data) {
        if (err) return callback(err);

        if (data.rows.length === 0)
            return callback('NO_USER');

        var user = data.rows[0];

        callback(null, user);
    });
};

exports.getChargingFromId = function(chargingId, callback) {
    query('SELECT * FROM chargings WHERE id = $1', [parseInt(chargingId)], function(err, data) {
        if (err) return callback(err);

        if (data.rows.length === 0)
            return callback('NO_CHARGING');

        var charging = data.rows[0];

        callback(null, charging);
    });
}

exports.getExchangeFromId = function(exchangeId, callback) {
    query('SELECT * FROM exchanges WHERE id = $1', [parseInt(exchangeId)], function(err, data) {
        if (err) return callback(err);

        if (data.rows.length === 0)
            return callback('NO_EXCHANGE');

        var exchange = data.rows[0];

        callback(null, exchange);
    });
}

exports.getAllUsers = function(callback) {
    query("select * from users ORDER BY id desc", function(err, data) {
        if (err) return callback(err);

        if (data.rows.length === 0)
            return callback('NO_USERS');

        callback(null, data.rows);
    });
}

exports.getLastUser = function(callback) {
    query("select * from users ORDER BY created desc limit 1", function(err, data) {
        if (err) return callback(err);

        if (data.rows.length === 0)
            return callback('NO_USERS');

        callback(null, data.rows[0]);
    });
}

exports.getAllUsersByUsername = function(username, callback) {
    query("select * from users where username like '%" + username + "%' ORDER BY id desc", function(err, data) {
        if (err) return callback(err);

        if (data.rows.length === 0)
            return callback('NO_USERS');

        callback(null, data.rows);
    });
}

exports.getAllUsersByEmail = function(email, callback) {
    query("select * from users where email like '%" + email + "%' ORDER BY id desc", function(err, data) {
        if (err) return callback(err);

        if (data.rows.length === 0)
            return callback('NO_USERS');

        callback(null, data.rows);
    });
}

exports.getAllBankCodes = function (callback) {
    query("select * from bank_codes  where confirmed < 2 ORDER BY confirmed ASC", function(err, data) {
        if (err) return callback(err);

        if (data.rows.length === 0)
            return callback('NO_BANKS');

        callback(null, data.rows);
    });
}

exports.getAllSupports = function (callback) {
    query("select supports.*, users.username from supports inner join users on(supports.creator_id = users.id) where parent_id = 0 ORDER BY created desc", function(err, data) {
        if (err) return callback(err);

        if (data.rows.length === 0)
            return callback('NO_SUPPORTS');

        callback(null, data.rows);
    });
}

exports.deleteUser = function(userId, callback) {
    query('delete from users where id = $1', [parseInt(userId)], function(err, data) {
        if (err) return callback(err);

        callback(null);
    });
}

exports.confirmUser = function(userId, callback) {
    query('UPDATE users SET confirmed = 1 WHERE id = $1', [parseInt(userId)], function(err, res) {
        if (err) return callback(err);
        callback(null);
    });
}

exports.cancelUser = function(userId, callback) {
    query('UPDATE users SET confirmed = 2 WHERE id = $1', [parseInt(userId)], function(err, res) {
        if (err) return callback(err);
        query('DELETE FROM chat_messages WHERE user_id = $1', [parseInt(userId)], function(err, res) {
            if (err) return callback(err);
            callback(null);
        });
    });
}

exports.removeUser = function(userId, callback) {
    query('UPDATE users SET confirmed = 3 WHERE id = $1', [parseInt(userId)], function(err, res) {
        if (err) return callback(err);
        query('DELETE FROM chat_messages WHERE user_id = $1', [parseInt(userId)], function(err, res) {
            if (err) return callback(err);
            
            callback(null);
        });
    });
}

exports.deleteCharging = function(chargingId, callback) {
    query('UPDATE chargings SET confirmed = 2 WHERE id = $1', [parseInt(chargingId)], function(err, res) {
        if (err) return callback(err);

        callback(null);
    });
}

exports.deleteExchange = function(exchangeId, callback) {
    query('UPDATE exchanges SET confirmed = 2 WHERE id = $1', [parseInt(exchangeId)], function(err, res) {
        if (err) return callback(err);

        callback(null);
    });
}

exports.confirmCharging = function(chargingId, callback) {
    query('UPDATE chargings SET confirmed = 1 WHERE id = $1', [parseInt(chargingId)], function(err, res) {
        if (err) return callback(err);

        callback(null);
    });
}

exports.confirmExchange = function(exchangeId, callback) {
    query('UPDATE exchanges SET confirmed = 1 WHERE id = $1', [parseInt(exchangeId)], function(err, res) {
        if (err) return callback(err);

        callback(null);
    });
}

exports.confirmBankCode = function(bankCodeId, callback) {
    query('UPDATE bank_codes SET confirmed = 1 WHERE id = $1', [parseInt(bankCodeId)], function(err, res) {
        if (err) return callback(err);

        callback(null);
    });
}

exports.cancelBankCode = function(bankCodeId, callback) {
    query('UPDATE bank_codes SET confirmed = 2 WHERE id = $1', [parseInt(bankCodeId)], function(err, res) {
        if (err) return callback(err);

        callback(null);
    });
}

exports.addRecoverId = function(userId, ipAddress, callback) {
    assert(userId && ipAddress && callback);

    var recoveryId = uuid.v4();

    query('INSERT INTO recovery (id, user_id, ip)  values($1, $2, $3)', [recoveryId, userId, ipAddress], function(err, res) {
        if (err) return callback(err);
        callback(null, recoveryId);
    });
};

exports.getUserBySessionId = function(sessionId, callback) {
    assert(sessionId && callback);
    query('SELECT * FROM users_view WHERE id = (SELECT user_id FROM sessions WHERE id = $1 AND ott = false AND expired > now())', [sessionId], function(err, response) {
        if (err) return callback(err);

        var data = response.rows;
        if (data.length === 0)
            return callback('NOT_VALID_SESSION');

        assert(data.length === 1);

        var user = data[0];
        assert(typeof user.balance_satoshis === 'number');

        callback(null, user);
    });
};

exports.getUserByValidRecoverId = function(recoverId, callback) {
    assert(recoverId && callback);
    query('SELECT * FROM users_view WHERE id = (SELECT user_id FROM recovery WHERE id = $1 AND used = false AND expired > NOW())', [recoverId], function(err, res) {
        if (err) return callback(err);

        var data = res.rows;
        if (data.length === 0)
            return callback('NOT_VALID_RECOVER_ID');

        assert(data.length === 1);
        return callback(null, data[0]);
    });
};

exports.getUserByPassword = function(user_id, password, callback) {
    var hashedPassword = passwordHash.generate(password);

    query('SELECT * FROM users_view WHERE id = $1', [user_id], function(err, res) {
        if (err) return callback(err);

        var data = res.rows;
        var verified = passwordHash.verify(password, res.rows[0].password);
        if (!verified)
            return callback('WRONG PASSWORD', false);

        return callback(null, true);
    });
}

exports.getUserByName = function(username, callback) {
    assert(username);
    query('SELECT * FROM users WHERE lower(username) = lower($1)', [username], function(err, result) {
        if (err) return callback(err);
        if (result.rows.length === 0)
            return callback('USER_DOES_NOT_EXIST');

        assert(result.rows.length === 1);
        callback(null, result.rows[0]);
    });
};

exports.updateUser = function(userId, bankName, accountNumber, bankAccountName, mobilePhoneNumber, balance,password, callback) {
    if(password == "*****"){
        query('UPDATE users SET bank_name = $1, account_number = $2, bank_account_name = $3, mobile_phone_number = $4 , balance_satoshis = $5  WHERE id = $6', [bankName,accountNumber,bankAccountName,mobilePhoneNumber,parseFloat(balance),parseInt(userId)], function(err, res) {
            if (err) return callback(err);

            callback(null);
        });
    }
    else{
        var hashedPassword = passwordHash.generate(password);
        query('UPDATE users SET bank_name = $1, account_number = $2, bank_account_name = $3, mobile_phone_number = $4 , balance_satoshis = $5, password = $6 WHERE id = $7', [bankName,accountNumber,bankAccountName,mobilePhoneNumber,parseFloat(balance),hashedPassword,parseInt(userId)], function(err, res) {
            if (err) return callback(err);

            callback(null);
        });
    }
    
}

exports.setPopUpNotice = function(noticement, callback){
    query('SELECT * FROM popup_notice', function(err, result) {
        if (err) return callback(err);
        if (result.rows.length === 0)
        {
            query('INSERT INTO popup_notice (name) VALUES ($1) ', [noticement], function(err) {
                if (err) return callback(err);
            });
        }
        else{
            console.log('noticement = >' + noticement);
            if(noticement == ""){
                console.log('notice empty');
                query('delete from popup_notice ', function(err) {
                    if (err) return callback(err);
                    
                });
            }
            
            else
            query('UPDATE popup_notice SET name=$1 ', [noticement], function(err) {
                if (err) return callback(err);
                
            });
        }
        callback(null);
    });
}
exports.getPopUpNotice = function(callback){
    query('SELECT * FROM popup_notice', function(err, result) {
        if (err) return callback(err);
        console.log(result.rows.length);
        if (result.rows.length == 0) return callback('POPUP_DOES_NOT_EXISTS');
        assert(result.rows.length == 1);
        callback(null,result.rows[0]);
    });
}

exports.updateUserBalance = function(userId, balance, callback) {
    query('UPDATE users SET balance_satoshis = $1 WHERE id = $2', [balance,parseInt(userId)], function(err, res) {
        if (err) return callback(err);

        callback(null);
    });
}

exports.getChargingWaiting = function(callback) {
    query("SELECT chargings.*,users.username FROM chargings LEFT JOIN users ON chargings.user_id = users.id WHERE chargings.confirmed = 0 ORDER BY created DESC", function(err, result) {
        if (err) return callback(err);
        callback(null, result.rows);
    });
}

exports.getExchangeWaiting = function(callback) {
    query("SELECT exchanges.*,users.username FROM exchanges LEFT JOIN users ON exchanges.user_id = users.id WHERE exchanges.confirmed = 0 ORDER BY created DESC", function(err, result) {
        if (err) return callback(err);
        callback(null, result.rows);
    });
}

exports.getMemberList = function(start, limit, condition, callback){
    var sql = "select * from users ";
    var total_cnt = 0;
    query(sql, function(err, data) {
        if (err) return callback(err);
        total_cnt = data.rows.length;
        if(condition['search']){
            var search = condition['search'];
            sql += "where username like '%"+search+"%' or email like '%"+search+"%' or bank_name like '%"+search+"%' or bank_account_name like '%"+search+"%' or mobile_phone_number like '%"+search+"%' ";
        }
        query(sql, function(err, data) {
            if (err) return callback(err);
            sub_cnt = data.rows.length;
            if(limit == -1){
                sql += "ORDER BY id desc";
            }
            else{
                sql += "ORDER BY id desc limit "+ limit +" offset " + start;
            }
            query(sql, function(err, datas) {
                if (err) return callback(err);
                var data = [];
                data.total = total_cnt;
                data.sub = sub_cnt;
                data.members = datas.rows;
                callback(null, data);
            });
        });
       
    });
}
exports.getSupportList = function(start, limit, condition, callback){
    var sql = "select supports.*,supports.id as supportid,users.* from supports inner join users on supports.creator_id = users.id where supports.parent_id = '0' ";
    var total_cnt = 0;
    query(sql, function(err, data) {
        if (err) return callback(err);
        total_cnt = data.rows.length;
        if(condition['search']){
            var search = condition['search'];
            sql += "and (supports.title like '%"+search+"%' or supports.message like '%"+search+"%') ";
        }
        query(sql, function(err, data) {
            if (err) return callback(err);
            sub_cnt = data.rows.length;
            if(limit == -1){
                sql += "ORDER BY supports.created desc";
            }
            else{
                sql += "ORDER BY supports.created desc limit "+ limit +" offset " + start;
            }
            query(sql, function(err, datas) {
                if (err) return callback(err);
                var data = [];
                data.total = total_cnt;
                data.sub = sub_cnt;
                data.supports = datas.rows;
                data.sql = sql;
                callback(null, data);
            });
        });
       
    });
}
exports.getChargingList = function(start, limit, condition, callback){
    var sql = "select users.*,users.id as user_id,chargings.*,to_char(chargings.created,'yyyy-mm-dd HH24:MI:SS') as created_date,chargings.id as charging_id from chargings left join users on users.id = chargings.user_id ";
    
    query(sql, function(err, data) {
        if (err) return callback(err);
        total_cnt = data.rows.length;
        if(condition['search']){
            var search = condition['search'];
            sql += "where users.username like '%"+search+"%' or users.email like '%"+search+"%' or users.bank_name like '%"+search+"%' or users.bank_account_name like '%"+search+"%' or users.bank_account_name like '%"+search+"%' or coalesce(to_char(chargings.created, 'YYYY-MM-DD HH24:MI:SS'), '') like '%"+search+"%' or CAST(user_id AS TEXT) like '%"+search+"%' ";
        }
        query(sql, function(err, data) {
            if (err) return callback(err);
            sub_cnt = data.rows.length;
            if(limit == -1){
                sql += "ORDER BY charging_id desc";
            }
            else{
                sql += "ORDER BY charging_id desc limit "+ limit +" offset " + start;
            }
            query(sql, function(err, datas) {
                if (err) return callback(err);
                var data = [];
                data.total = total_cnt;
                data.sub = sub_cnt;
                data.members = datas.rows;
                callback(null, data);
            });
        });
       
    });
}
exports.getExchangeList = function(start, limit, condition, callback){
    var sql = "select users.*,users.id as user_id,exchanges.*,to_char(exchanges.created,'yyyy-mm-dd HH24:MI:SS') as created_date,exchanges.id as exchanges_id from exchanges left join users on users.id = exchanges.user_id ";
    
    query(sql, function(err, data) {
        if (err) return callback(err);
        total_cnt = data.rows.length;
        if(condition['search']){
            var search = condition['search'];
            sql += "where users.username like '%"+search+"%' or users.email like '%"+search+"%' or users.bank_name like '%"+search+"%' or users.bank_account_name like '%"+search+"%' or users.bank_account_name like '%"+search+"%' or coalesce(to_char(exchanges.created, 'YYYY-MM-DD HH24:MI:SS'), '') like '%"+search+"%' or CAST(user_id AS TEXT) like '%"+search+"%' ";
        }
        query(sql, function(err, data) {
            if (err) return callback(err);
            sub_cnt = data.rows.length;
            if(limit == -1){
                sql += "ORDER BY exchanges_id desc";
            }
            else{
                sql += "ORDER BY exchanges_id desc limit "+ limit +" offset " + start;
            }
            query(sql, function(err, datas) {
                if (err) return callback(err);
                var data = [];
                data.total = total_cnt;
                data.sub = sub_cnt;
                data.members = datas.rows;
                callback(null, data);
            });
        });
       
    });
}
exports.getBlackList = function(start, limit, condition, callback){
    var sql = "select * from black_list ";
    
    query(sql, function(err, data) {
        if (err) return callback(err);
        total_cnt = data.rows.length;
        if(condition['search']){
            var search = condition['search'];
            sql += "where ipaddress like '%"+search+"%' ";
        }
        query(sql, function(err, data) {
            if (err) return callback(err);
            sub_cnt = data.rows.length;
            if(limit == -1){
                sql += "ORDER BY id asc";
            }
            else{
                sql += "ORDER BY id asc limit "+ limit +" offset " + start;
            }
            console.log(sql);
            query(sql, function(err, datas) {
                if (err) return callback(err);
                var data = [];
                data.total = total_cnt;
                data.sub = sub_cnt;
                data.members = datas.rows;
                callback(null, data);
            });
        });
       
    });
}
exports.addBlackList = function(ip,callback){
    var sql = 'INSERT INTO black_list (ipaddress) values($1)';
    query(sql, [ip], function(err, res) {
        if(err)
            return callback(err);

        assert(res.rowCount === 1);

        callback(null);
    });
}
exports.removeBlackList = function(id, callback){
    assert(id);
    query('DELETE FROM black_list WHERE id = $1 ', [id], function(err, result) {
        if (err) return callback(err);

        callback(null);
    });
}
/* Sets the recovery record to userd and update password */
exports.changePasswordFromRecoverId = function(recoverId, password, callback) {
    assert(recoverId && password && callback);
    var hashedPassword = passwordHash.generate(password);

    var sql = m(function() {/*
     WITH t as (UPDATE recovery SET used = true, expired = now()
     WHERE id = $1 AND used = false AND expired > now()
     RETURNING *) UPDATE users SET password = $2 where id = (SELECT user_id FROM t) RETURNING *
     */});

    query(sql, [recoverId, hashedPassword], function(err, res) {
            if (err)
                return callback(err);

            var data = res.rows;
            if (data.length === 0)
                return callback('NOT_VALID_RECOVER_ID');

            assert(data.length === 1);

            callback(null, data[0]);
        }
    );
};

exports.getGame = function(gameId, callback) {
    assert(gameId && callback);

    query('SELECT * FROM games ' +
    'LEFT JOIN game_hashes ON games.id = game_hashes.game_id ' +
    'WHERE games.id = $1 AND games.ended = TRUE', [gameId], function(err, result) {
        if (err) return callback(err);
        if (result.rows.length == 0) return callback('GAME_DOES_NOT_EXISTS');
        assert(result.rows.length == 1);
        callback(null, result.rows[0]);
    });
};

exports.getGamesPlays = function(gameId, callback) {
    query('SELECT u.username, p.bet, p.cash_out, p.bonus FROM plays p, users u ' +
        ' WHERE game_id = $1 AND p.user_id = u.id ORDER by p.cash_out/p.bet::float DESC NULLS LAST, p.bet DESC', [gameId],
        function(err, result) {
            if (err) return callback(err);
            return callback(null, result.rows);
        }
    );
};

function addSatoshis(client, userId, amount, callback) {
    client.query('UPDATE users SET balance_satoshis = balance_satoshis + $1 WHERE id = $2', [amount, userId], function(err, res) {
        if (err) return callback(err);
        assert(res.rowCount === 1);
        callback(null);
    });
}

exports.getUserPlays = function(userId, limit, offset, callback) {
    assert(userId);

    query('SELECT p.bet, p.bonus, p.cash_out, p.created, p.game_id, g.game_crash FROM plays p ' +
        'LEFT JOIN (SELECT * FROM games) g ON g.id = p.game_id ' +
        'WHERE p.user_id = $1 AND g.ended = true ORDER BY p.id DESC LIMIT $2 OFFSET $3',
        [userId, limit, offset], function(err, result) {
            if (err) return callback(err);
            callback(null, result.rows);
        }
    );
};

exports.getGiveAwaysAmount = function(userId, callback) {
    assert(userId);
    query('SELECT SUM(g.amount) FROM giveaways g where user_id = $1', [userId], function(err,result) {
        if (err) return callback(err);
        return callback(null, result.rows[0]);
    });
};

exports.addGiveaway = function(userId, callback) {
    assert(userId && callback);
    getClient(function(client, callback) {

            client.query('SELECT last_giveaway FROM users_view WHERE id = $1', [userId] , function(err, result) {
                if (err) return callback(err);

                if (!result.rows) return callback('USER_DOES_NOT_EXIST');
                assert(result.rows.length === 1);
                var lastGiveaway = result.rows[0].last_giveaway;
                var eligible = lib.isEligibleForGiveAway(lastGiveaway);

                if (typeof eligible === 'number') {
                    return callback({ message: 'NOT_ELIGIBLE', time: eligible});
                }

                var amount = 200; // 2 bits
                client.query('INSERT INTO giveaways(user_id, amount) VALUES($1, $2) ', [userId, amount], function(err) {
                    if (err) return callback(err);

                    addSatoshis(client, userId, amount, function(err) {
                        if (err) return callback(err);

                        callback(null);
                    });
                });
            });

        }, callback
    );
};

exports.addRawGiveaway = function(userNames, amount, callback) {
    assert(userNames && amount && callback);

    getClient(function(client, callback) {

        var tasks = userNames.map(function(username) {
            return function(callback) {

                client.query('SELECT id FROM users WHERE lower(username) = lower($1)', [username], function(err, result) {
                    if (err) return callback('unable to add bits');

                    if (result.rows.length === 0) return callback(username + ' didnt exists');

                    var userId = result.rows[0].id;
                    client.query('INSERT INTO giveaways(user_id, amount) VALUES($1, $2) ', [userId, amount], function(err, result) {
                        if (err) return callback(err);

                        assert(result.rowCount == 1);
                        addSatoshis(client, userId, amount, function(err) {
                            if (err) return callback(err);
                            callback(null);
                        });
                    });
                });
            };
        });

        async.series(tasks, function(err, ret) {
            if (err) return callback(err);
            return callback(null, ret);
        });

    }, callback);
};

exports.getUserNetProfit = function(userId, callback) {
    assert(userId);
    query('SELECT (' +
            'COALESCE(SUM(cash_out), 0) + ' +
            'COALESCE(SUM(bonus), 0) - ' +
            'COALESCE(SUM(bet), 0)) profit ' +
        'FROM plays ' +
        'WHERE user_id = $1', [userId], function(err, result) {
            if (err) return callback(err);
            assert(result.rows.length == 1);
            return callback(null, result.rows[0]);
        }
    );
};

exports.getUserNetProfitLast = function(userId, last, callback) {
    assert(userId);
    query('SELECT (' +
            'COALESCE(SUM(cash_out), 0) + ' +
            'COALESCE(SUM(bonus), 0) - ' +
            'COALESCE(SUM(bet), 0))::bigint profit ' +
            'FROM ( ' +
                'SELECT * FROM plays ' +
                'WHERE user_id = $1 ' +
                'ORDER BY id DESC ' +
                'LIMIT $2 ' +
            ') restricted ', [userId, last], function(err, result) {
            if (err) return callback(err);
            assert(result.rows.length == 1);
            return callback(null, result.rows[0].profit);
        }
    );
};

exports.getPublicStats = function(username, callback) {

  var sql = 'SELECT id AS user_id, username, gross_profit, net_profit, games_played, ' +
            'COALESCE((SELECT rank FROM leaderboard WHERE user_id = id), -1) rank ' +
            'FROM users WHERE lower(username) = lower($1)';

    query(sql,
        [username], function(err, result) {
            if (err) return callback(err);

            if (result.rows.length !== 1)
                return callback('USER_DOES_NOT_EXIST');

            return callback(null, result.rows[0]);
        }
    );
};

exports.makeWithdrawal = function(userId, satoshis, withdrawalAddress, withdrawalId, callback) {
    assert(typeof userId === 'number');
    assert(typeof satoshis === 'number');
    assert(typeof withdrawalAddress === 'string');
    assert(satoshis > 10000);
    assert(lib.isUUIDv4(withdrawalId));

    getClient(function(client, callback) {
		

        client.query("UPDATE users SET balance_satoshis = balance_satoshis - $1 WHERE id = $2",
            [satoshis, userId], function(err, response) {
            if (err) return callback(err);

            if (response.rowCount !== 1)
                return callback(new Error('Unexpected withdrawal row count: \n' + response));

            client.query('INSERT INTO fundings(user_id, amount, bitcoin_withdrawal_address, withdrawal_id) ' +
                "VALUES($1, $2, $3, $4) RETURNING id",
                [userId, -1 * satoshis, withdrawalAddress, withdrawalId],
				
                function(err, response) {
                    if (err) return callback(err);

                    var fundingId = response.rows[0].id;
                    assert(typeof fundingId === 'number');

                    callback(null, fundingId);
                }
            );
        });

    }, callback);
};

exports.getWithdrawals = function(userId, callback) {
    assert(userId && callback);

    query("SELECT exchanges.*, users.bank_name, users.account_number, users.bank_account_name FROM exchanges LEFT JOIN users ON(users.id = exchanges.user_id) WHERE user_id = $1 ORDER BY created DESC", [userId], function(err, result) {
        if (err) return callback(err);

        callback(null, result.rows);
    });
};

exports.getDeposits = function(userId, callback) {
    assert(userId && callback);

    query("SELECT * FROM fundings WHERE user_id = $1 AND amount > 0 ORDER BY created DESC", [userId], function(err, result) {
        if (err) return callback(err);

        var data = result.rows.map(function(row) {
            return {
                amount: row.amount,
                txid: row.bitcoin_deposit_txid,
                created: row.created
            };
        });
        callback(null, data);
    });
};

exports.getUsersDeposits = function(userId, callback) {
    assert(userId && callback);
    query("SELECT chargings.*, users.bank_name, users.account_number, users.bank_account_name FROM chargings LEFT JOIN users ON(users.id = chargings.user_id) WHERE user_id = $1 ORDER BY created DESC", [userId], function(err, result) {
        if (err) return callback(err);

        callback(null, result.rows);
    });
};

exports.getAccountNumber = function(userId, callback) {
    assert(userId && callback);

    query("SELECT * FROM users WHERE id = $1 LIMIT $2", [userId, 1], function(err, result) {
        if (err) return callback(err);

        callback(null, result.rows[0].account_number);
    });
}

exports.getBankCode = function(callback) {
    query("SELECT * FROM bank_codes WHERE confirmed = $1 LIMIT $2", [1, 1], function(err, result) {
        if (err) return callback(err);

        callback(null, result.rows[0]);
    });
}

exports.getDepositsAmount = function(userId, callback) {
    assert(userId);
    query('SELECT SUM(f.amount) FROM fundings f WHERE user_id = $1 AND amount >= 0', [userId], function(err, result) {
        if (err) return callback(err);
        callback(null, result.rows[0]);
    });
};

exports.getWithdrawalsAmount = function(userId, callback) {
    assert(userId);
    query('SELECT SUM(f.amount) FROM fundings f WHERE user_id = $1 AND amount < 0', [userId], function(err, result) {
        if (err) return callback(err);

        callback(null, result.rows[0]);
    });
};

exports.getUserSupports = function (userId, callback) {
    assert(userId);
    query('SELECT * FROM supports WHERE creator_id = $1 AND parent_id=0', [userId], function(err, result) {
        if (err) return callback(err);

        callback(null, result.rows);
    });
}

exports.getSupport = function (supportId, callback) {
    assert(supportId);
    query('SELECT * FROM supports WHERE id = $1 or parent_id = $1 ORDER BY created asc', [supportId], function(err, result) {
        if (err) return callback(err);

        callback(null, result.rows);
    });
}

exports.deleteSupport = function(supportId, callback) {
    assert(supportId);
    query('DELETE FROM supports WHERE id = $1 or parent_id = $1', [supportId], function(err, result) {
        if (err) return callback(err);

        callback(null);
    });
}

exports.setFundingsWithdrawalTxid = function(fundingId, txid, callback) {
    assert(typeof fundingId === 'number');
    assert(typeof txid === 'string');
    assert(callback);

    query('UPDATE fundings SET bitcoin_withdrawal_txid = $1 WHERE id = $2', [txid, fundingId],
        function(err, result) {
           if (err) return callback(err);

            assert(result.rowCount === 1);

            callback(null);
        }
    );
};


exports.getLeaderBoard = function(byDb, order, callback) {
    var sql = 'SELECT * FROM leaderboard ORDER BY ' + byDb + ' ' + order + ' LIMIT 100';
    query(sql, function(err, data) {
        if (err)
            return callback(err);
        callback(null, data.rows);
    });
};

exports.addChatMessage = function(userId, created, message, channelName, isBot, callback) {
    var sql = 'INSERT INTO chat_messages (user_id, created, message, channel, is_bot) values($1, $2, $3, $4, $5)';
    query(sql, [userId, created, message, channelName, isBot], function(err, res) {
        if(err)
            return callback(err);

        assert(res.rowCount === 1);

        callback(null);
    });
};

exports.getChatTable = function(limit, channelName, callback) {
    assert(typeof limit === 'number');
    var sql = "SELECT chat_messages.created AS date, 'say' AS type, users.username, users.userclass AS role, chat_messages.message, is_bot AS bot " +
        "FROM chat_messages JOIN users ON users.id = chat_messages.user_id WHERE channel = $1 ORDER BY chat_messages.id DESC LIMIT $2";
    query(sql, [channelName, limit], function(err, data) {
        if(err)
            return callback(err);
        callback(null, data.rows);
    });
};

//Get the history of the chat of all channels except the mods channel
exports.getAllChatTable = function(limit, callback) {
    assert(typeof limit === 'number');
    var sql = m(function(){/*
     SELECT chat_messages.created AS date, 'say' AS type, users.username, users.userclass AS role, chat_messages.message, is_bot AS bot, chat_messages.channel AS "channelName"
     FROM chat_messages JOIN users ON users.id = chat_messages.user_id WHERE channel <> 'moderators'  ORDER BY chat_messages.id DESC LIMIT $1
    */});
    query(sql, [limit], function(err, data) {
        if(err)
            return callback(err);
        callback(null, data.rows);
    });
};
exports.getBlockList = function(callback){
    query('SELECT * from black_list', function(err, result) {
        if (err) return callback(err);
console.log('here');
console.log(result);
        if (result.rows.length == 0) return callback('blacklist does not exist');

        callback(null, result.rows);
    });
}
exports.getSiteStats = function(callback) {

    function as(name, callback) {
        return function(err, results) {
            if (err)
                return callback(err);

            assert(results.rows.length === 1);
            callback(null, [name, results.rows[0]]);
        }
    }

    var tasks = [
        function(callback) {
            query('SELECT COUNT(*) FROM users', as('users', callback));
        },
        function (callback) {
            query('SELECT COUNT(*) FROM games', as('games', callback));
        },
        function(callback) {
            query('SELECT COALESCE(SUM(fundings.amount), 0)::bigint sum FROM fundings WHERE amount < 0', as('withdrawals', callback));
        },
        function(callback) {
            query("SELECT COUNT(*) FROM games WHERE ended = false AND created < NOW() - interval '5 minutes'", as('unterminated_games', callback));
        },
        function(callback) {
            query('SELECT COUNT(*) FROM fundings WHERE amount < 0 AND bitcoin_withdrawal_txid IS NULL', as('pending_withdrawals', callback));
        },
        function(callback) {
            query('SELECT COALESCE(SUM(fundings.amount), 0)::bigint sum FROM fundings WHERE amount > 0', as('deposits', callback));
        },
        function(callback) {
            query('SELECT ' +
                'COUNT(*) count, ' +
                'SUM(plays.bet)::bigint total_bet, ' +
                'SUM(plays.cash_out)::bigint cashed_out, ' +
                'SUM(plays.bonus)::bigint bonused ' +
                'FROM plays', as('plays', callback));
        }
    ];

    async.series(tasks, function(err, results) {
       if (err) return callback(err);

       var data = {};

        results.forEach(function(entry) {
           data[entry[0]] = entry[1];
        });

        callback(null, data);
    });
};

exports.createCharging = function( userId, amount, callback) {
    query('INSERT INTO chargings (user_id, amount) VALUES($1, $2)', [userId, amount], function(err) {
            if (err) return callback(err);

            callback(null);
        });
}

exports.createExchange = function(userId, amount, callback) {
    query('INSERT INTO exchanges (user_id, amount) VALUES($1, $2)', [userId, amount], function(err) {
        if (err) return callback(err);

        callback(null);
    });
}

exports.createBankCode = function(bank_name, account_number, account_name, callback){
    query('INSERT INTO bank_codes (bank_account_name, bank_account_number, bank_name, confirmed) VALUES($1, $2, $3, $4)', [account_name, account_number, bank_name, '0'], function(err) {
        if (err) return callback(err);

        callback(null);
    });
}

exports.createSupport = function(title, message, userId, callback){
    query('INSERT INTO supports (title, message, parent_id, creator_id, confirmed) VALUES($1, $2, $3, $4, $5)', [title, message, 0, userId, 0], function(err) {
        if (err) return callback(err);

        callback(null);
    });
}

exports.supportApply = function (supportId, message, callback) {
    query('INSERT INTO supports (title, message, parent_id, creator_id, confirmed) VALUES($1, $2, $3, $4, $5)', ['', message, supportId, 0, 1], function(err) {
        if (err) return callback(err);

        query('UPDATE supports SET confirmed=1 WHERE id=$1', [supportId], function (err) {
            if (err) return callback(err);

            callback(null);
        })

    });
}

exports.supportApplyUser = function (supportId, message, callback) {
    query('INSERT INTO supports (title, message, parent_id, creator_id, confirmed) VALUES($1, $2, $3, $4, $5)', ['', message, supportId, 0, 2], function(err) {
        if (err) return callback(err);

        query('UPDATE supports SET confirmed=2 WHERE id=$1', [supportId], function (err) {
            if (err) return callback(err);

            callback(null);
        })

    });
}

exports.getAllCharging = function(callback) {
    query('SELECT chargings.id, chargings.created, chargings.amount, chargings.user_id, chargings.confirmed, users.username, users.bank_name, users.bank_account_name, users.account_number FROM chargings ' +
        'LEFT JOIN users ON chargings.user_id = users.id', function(err, result) {
        if (err) return callback(err);
        if (result.rows.length == 0) return callback('Charging does not exist');

        callback(null, result.rows);
    });
};

exports.isChargedOnce = function(user_id, callback){
    query('SELECT id FROM chargings WHERE user_id=' + user_id + ' AND confirmed = 1', function(err, result) {
        if (err) return callback(err);
        if (result === undefined) return callback(null, 'No');
        if (result.rowCount == 0) return callback(null, 'No');

        callback(null, 'Yes');
    });
}
exports.getAllChargingByUsername = function(username, callback) {
    query("SELECT chargings.id, chargings.created, chargings.amount, chargings.user_id, chargings.confirmed, users.username, users.bank_name, users.bank_account_name, users.account_number FROM chargings " +
        "LEFT JOIN users ON chargings.user_id = users.id WHERE users.username like '%" + username + "%'", function(err, result) {
        if (err) return callback(err);
        if (result.rows.length == 0) return callback('Charging does not exist');

        callback(null, result.rows);
    });
}

exports.getAllChargingByDate = function(search_date, callback) {
    query("SELECT chargings.id, chargings.created, chargings.amount, chargings.user_id, chargings.confirmed, users.username, users.bank_name, users.bank_account_name, users.account_number FROM chargings " +
        "LEFT JOIN users ON chargings.user_id = users.id WHERE coalesce(to_char(chargings.created, 'YYYY-MM-DD HH24:MI:SS'), '') like '%" + search_date + "%'", function(err, result) {
        if (err) return callback(err);
        if (result.rows.length == 0) return callback('Charging does not exist');

        callback(null, result.rows);
    });
}

exports.getAllExchange = function(callback) {
    query('SELECT exchanges.id, exchanges.created, exchanges.amount, exchanges.user_id, exchanges.confirmed, users.username, users.bank_name, users.bank_account_name, users.account_number FROM exchanges ' +
        'LEFT JOIN users ON exchanges.user_id = users.id', function(err, result) {
        if (err) return callback(err);
        if (result.rows.length == 0) return callback('Exchanges does not exist');

        callback(null, result.rows);
    });
};

exports.getAllExchangeByUsername = function(username, callback) {
    query("SELECT exchanges.id, exchanges.created, exchanges.amount, exchanges.user_id, exchanges.confirmed, users.username, users.bank_name, users.bank_account_name, users.account_number FROM exchanges " +
        "LEFT JOIN users ON exchanges.user_id = users.id WHERE users.username like '%" + username + "%'", function(err, result) {
        if (err) return callback(err);
        if (result.rows.length == 0) return callback('Exchanges does not exist');

        callback(null, result.rows);
    });
}

exports.getAllExchangeByDate = function(search_date, callback) {
    query("SELECT exchanges.id, exchanges.created, exchanges.amount, exchanges.user_id, exchanges.confirmed, users.username, users.bank_name, users.bank_account_name, users.account_number FROM exchanges " +
        "LEFT JOIN users ON exchanges.user_id = users.id WHERE coalesce(to_char(exchanges.created, 'YYYY-MM-DD HH24:MI:SS'), '') like '%" + search_date + "%'", function(err, result) {
        if (err) return callback(err);
        if (result.rows.length == 0) return callback('Charging does not exist');

        callback(null, result.rows);
    });
}

exports.getStatistics = function (search_year, search_month, callback) {
    var search_start = search_year + "-" + search_month + "-01";
    var search_end = search_year + "-" + search_month + "-31";

    query("select t.*, (select count(id) from users where coalesce(to_char(created, 'YYYY-MM-DD HH24:MI:SS'), '') like concat(t.cdate,'%') ) as joined, "+
        "(select count(id) from sessions where coalesce(to_char(created, 'YYYY-MM-DD HH24:MI:SS'), '') like concat(t.cdate,'%') ) as login,"+
        "COALESCE((select sum(amount) from chargings where coalesce(to_char(created, 'YYYY-MM-DD HH24:MI:SS'), '') like concat(t.cdate,'%') and confirmed=1), 0) as charging, "+
        "COALESCE((select sum(amount) from exchanges where coalesce(to_char(created, 'YYYY-MM-DD HH24:MI:SS'), '') like concat(t.cdate,'%') and confirmed=1), 0) as exchange, "+
        "(select count(ip_address) from accesses where coalesce(to_char(created, 'YYYY-MM-DD HH24:MI:SS'), '') like concat(t.cdate,'%') and user_agent !~* 'Mobile|iP(hone|od|ad)|Android|BlackBerry|IEMobile|Kindle|NetFront|Silk-Accelerated|(hpw|web)OS|Fennec|Minimo|Opera M(obi|ini)|Blazer|Dolfin|Dolphin|Skyfire|Zune') as count_pc,"+
        "(select count(ip_address) from accesses where coalesce(to_char(created, 'YYYY-MM-DD HH24:MI:SS'), '') like concat(t.cdate,'%') and user_agent ~* 'Mobile|iP(hone|od|ad)|Android|BlackBerry|IEMobile|Kindle|NetFront|Silk-Accelerated|(hpw|web)OS|Fennec|Minimo|Opera M(obi|ini)|Blazer|Dolfin|Dolphin|Skyfire|Zune') as count_mobile" +
        " from (select substr(coalesce(to_char(created, 'YYYY-MM-DD HH24:MI:SS'), ''), 0, 11 ) as cdate from sessions where EXTRACT(MONTH from created) = "+search_month+" group by substr(coalesce(to_char(created, 'YYYY-MM-DD HH24:MI:SS'), ''), 0, 11) order by cdate asc) as t;", function(err, result) {
            if (err) return callback(err);

            callback(null, result.rows);
    });

}