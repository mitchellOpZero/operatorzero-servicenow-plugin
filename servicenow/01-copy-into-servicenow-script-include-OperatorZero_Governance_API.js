/**
 * OperatorZero_Governance_API
 *
 * ServiceNow-side policy boundary for OperatorZero.
 *
 * MCP path:
 * Claude Code -> OperatorZero MCP -> Scripted REST API -> this Script Include -> ServiceNow
 *
 * This Script Include decides what is allowed. The MCP client must not be the
 * only control point for writes.
 */
var OperatorZero_Governance_API = Class.create();
OperatorZero_Governance_API.prototype = {
    initialize: function() {
        this.maxLimit = 100;

        this.blockedWriteTables = this._csv([
            'sys_user',
            'sys_user_has_role',
            'sys_group_has_role',
            'sys_security_acl',
            'sys_properties',
            'sys_auth_profile',
            'sys_oauth_client',
            'oauth_entity',
            'sys_certificate',
            'sys_script_fix',
            'sys_scope_privilege'
        ].join(','));

        this.allowedWriteTables = this._csv([
            'sys_script',
            'sys_script_include',
            'sys_ui_script',
            'sys_ui_policy',
            'sys_ui_policy_action',
            'sys_hub_flow',
            'sys_hub_flow_base',
            'sys_hub_action_type_definition',
            'sys_hub_sub_flow',
            'sc_cat_item',
            'item_option_new',
            'io_set_item',
            'catalog_script_client',
            'catalog_ui_policy',
            'sys_ui_message',
            'sys_documentation'
        ].join(','));
    },

    execute: function(params) {
        params = params || {};
        var action = params.action + '';

        try {
            if (action === 'governance_check') return this._ok(this._governanceCheck(params));
            if (action === 'query') return this._ok(this._query(params));
            if (action === 'get') return this._ok(this._get(params));
            if (action === 'schema') return this._ok(this._schema(params));
            if (action === 'record') return this._record(params);
            if (action === 'script') return this._script(params);

            return this._fail('Unknown action: ' + action + '. Allowed actions: governance_check, query, get, schema, record, script');
        } catch (e) {
            return this._fail(e.getMessage ? e.getMessage() : String(e));
        }
    },

    _governanceCheck: function(params) {
        var decision = this._policy(params.operation + '', params.table + '', params);
        decision.decision_id = gs.generateGUID ? gs.generateGUID() : new GlideGuid().generate(null);
        this._logDecision('governance_check', params, decision);
        return decision;
    },

    _record: function(params) {
        var operation = params.operation + '';
        var table = params.table + '';
        var decision = this._policy(operation, table, params);
        this._logDecision('record', params, decision);

        if (decision.decision === 'blocked') {
            return {
                success: false,
                blocked: true,
                result: decision,
                error: decision.reasons.join('; ')
            };
        }

        if (operation === 'insert') return this._ok(this._insert(params));
        if (operation === 'update') return this._ok(this._update(params));
        if (operation === 'upsert') return this._ok(this._upsert(params));
        if (operation === 'delete') return this._ok(this._delete(params));

        return this._fail('Unknown record operation: ' + operation);
    },

    _script: function(params) {
        var decision = this._policy('script', '', params);
        this._logDecision('script', params, decision);

        if (decision.decision === 'blocked') {
            return {
                success: false,
                blocked: true,
                result: decision,
                error: decision.reasons.join('; ')
            };
        }

        var answer = null;
        var script = params.script + '';
        eval(script);

        return this._ok({
            operation: 'script',
            result: answer
        });
    },

    _policy: function(operation, table, params) {
        var reasons = [];
        var warnings = [];
        var isRead = operation === 'query' || operation === 'get' || operation === 'schema';
        var isWrite = operation === 'insert' || operation === 'update' || operation === 'upsert' || operation === 'delete';
        var isScript = operation === 'script';

        if (!operation) reasons.push('operation_required');
        if (operation && !isRead && !isWrite && !isScript) reasons.push('unsupported_operation');

        if (isRead) {
            return {
                decision: reasons.length ? 'blocked' : 'approved',
                reasons: reasons.length ? reasons : ['read_operation'],
                warnings: warnings,
                field_count: 0
            };
        }

        if (isScript) {
            if (this._isProduction()) reasons.push('production_instances_are_read_only_by_default');
            if (!params.intent) reasons.push('intent_required_for_script');
            if (!params.script) reasons.push('script_required');
            if ((params.script + '').length > 10000) reasons.push('script_too_large');
            if (!/GlideRecord\s*\(/.test(params.script + '')) warnings.push('script_does_not_reference_gliderecord');
            if (this._scriptHasBlockedPattern(params.script + '')) reasons.push('script_contains_blocked_api');

            return {
                decision: reasons.length ? 'blocked' : (warnings.length ? 'warn' : 'approved'),
                reasons: reasons.length ? reasons : ['governance_script_policy_passed'],
                warnings: warnings,
                field_count: 0
            };
        }

        if (!table) reasons.push('table_required');

        if (this._isProduction()) reasons.push('production_instances_are_read_only_by_default');
        if (table && this.blockedWriteTables[table]) reasons.push('table_is_blocked_by_governance_api');
        if (table && !this.allowedWriteTables[table]) reasons.push('table_is_not_in_governance_write_allowlist');

        if (operation === 'delete') {
            warnings.push('delete_operation_requires_extra_confirmation');
            if (!params.sys_id) reasons.push('delete_requires_sys_id');
        }

        if ((operation === 'insert' || operation === 'update' || operation === 'upsert') && !params.values) {
            reasons.push('values_required_for_insert_update_or_upsert');
        }

        var fields = this._fieldNames(params.values);
        for (var i = 0; i < fields.length; i++) {
            if (/password|passwd|secret|token|credential|private_key|client_secret|access_token|refresh_token/i.test(fields[i])) {
                reasons.push('sensitive_credential_like_field_write_blocked');
                break;
            }
        }

        return {
            decision: reasons.length ? 'blocked' : (warnings.length ? 'warn' : 'approved'),
            reasons: reasons.length ? reasons : ['governance_policy_passed'],
            warnings: warnings,
            field_count: fields.length
        };
    },

    _scriptHasBlockedPattern: function(script) {
        return /Packages\s*\.|java\.lang|Runtime\s*\.|GlideSysAttachment|GlideEncrypter|new\s+Packages|eval\s*\(|Function\s*\(/i.test(script || '');
    },

    _query: function(params) {
        var gr = this._recordForTable(params.table);
        if (params.query) gr.addEncodedQuery(params.query + '');
        gr.setLimit(this._limit(params.limit));
        gr.query();

        var records = [];
        while (gr.next()) records.push(this._recordToObject(gr, params.fields));

        return {
            table: params.table + '',
            count: records.length,
            records: records
        };
    },

    _get: function(params) {
        if (!params.sys_id) throw new Error('sys_id is required');
        var gr = this._recordForTable(params.table);
        if (!gr.get(params.sys_id + '')) {
            return {
                found: false,
                table: params.table + '',
                error: 'Record not found'
            };
        }
        return {
            found: true,
            table: params.table + '',
            record: this._recordToObject(gr, params.fields)
        };
    },

    _schema: function(params) {
        if (!params.table) throw new Error('table is required');
        var table = params.table + '';
        var fields = [];
        var dict = new GlideRecord('sys_dictionary');
        dict.addQuery('name', table);
        dict.addQuery('element', '!=', '');
        dict.addQuery('internal_type', '!=', 'collection');
        dict.orderBy('position');
        dict.orderBy('element');
        dict.setLimit(this.maxLimit);
        dict.query();

        while (dict.next()) {
            fields.push({
                name: dict.getValue('element') || '',
                label: dict.getValue('column_label') || dict.getDisplayValue('column_label') || dict.getValue('element') || '',
                type: dict.getDisplayValue('internal_type') || dict.getValue('internal_type') || '',
                mandatory: dict.getValue('mandatory') === 'true' || dict.getValue('mandatory') === '1',
                reference: dict.getValue('reference') || null,
                max_length: dict.getValue('max_length') || '',
                source_table: dict.getValue('name') || table
            });
        }

        return {
            table: table,
            field_count: fields.length,
            fields: fields
        };
    },

    _insert: function(params) {
        var gr = this._recordForTable(params.table);
        this._applyValues(gr, params.values);
        var id = gr.insert();
        if (!id) throw new Error('Insert failed');
        gr.get(id);
        return {
            operation: 'insert',
            table: params.table + '',
            record: this._recordToObject(gr, params.fields)
        };
    },

    _update: function(params) {
        if (!params.sys_id) throw new Error('sys_id is required for update');
        var gr = this._recordForTable(params.table);
        if (!gr.get(params.sys_id + '')) throw new Error('Record not found: ' + params.sys_id);
        this._applyValues(gr, params.values);
        gr.update();
        return {
            operation: 'update',
            table: params.table + '',
            record: this._recordToObject(gr, params.fields)
        };
    },

    _upsert: function(params) {
        if (params.sys_id) return this._update(params);
        if (params.query) {
            var gr = this._recordForTable(params.table);
            gr.addEncodedQuery(params.query + '');
            gr.setLimit(2);
            gr.query();
            if (gr.next()) {
                var first = gr.getUniqueValue();
                if (gr.next()) throw new Error('Upsert query matched more than one record');
                params.sys_id = first;
                return this._update(params);
            }
        }
        return this._insert(params);
    },

    _delete: function(params) {
        if (!params.sys_id) throw new Error('sys_id is required for delete');
        var gr = this._recordForTable(params.table);
        if (!gr.get(params.sys_id + '')) throw new Error('Record not found: ' + params.sys_id);
        gr.deleteRecord();
        return {
            operation: 'delete',
            table: params.table + '',
            sys_id: params.sys_id + '',
            deleted: true
        };
    },

    _recordForTable: function(table) {
        if (!table) throw new Error('table is required');
        var gr = new GlideRecord(table + '');
        if (gr.isValid && !gr.isValid()) throw new Error('Invalid table: ' + table);
        return gr;
    },

    _applyValues: function(gr, values) {
        values = values || {};
        for (var field in values) {
            if (!values.hasOwnProperty(field)) continue;
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) throw new Error('Invalid field name: ' + field);
            if (!gr.isValidField(field)) throw new Error('Invalid field for table: ' + field);
            gr.setValue(field, values[field]);
        }
    },

    _recordToObject: function(gr, fields) {
        var row = { sys_id: gr.getUniqueValue() };
        var i;

        if (fields && fields.length) {
            for (i = 0; i < fields.length; i++) {
                var field = fields[i] + '';
                if (field === 'sys_id') {
                    row.sys_id = gr.getUniqueValue();
                } else if (gr.isValidField(field)) {
                    row[field] = gr.getValue(field);
                }
            }
            return row;
        }

        var defaults = ['number', 'name', 'short_description', 'active', 'sys_created_on', 'sys_updated_on'];
        for (i = 0; i < defaults.length; i++) {
            if (gr.isValidField(defaults[i])) row[defaults[i]] = gr.getValue(defaults[i]);
        }
        return row;
    },

    _fieldNames: function(values) {
        var names = [];
        values = values || {};
        for (var field in values) {
            if (values.hasOwnProperty(field)) names.push(field);
        }
        names.sort();
        return names;
    },

    _limit: function(value) {
        var n = parseInt(value || this.maxLimit, 10) || this.maxLimit;
        if (n < 1) return 1;
        if (n > this.maxLimit) return this.maxLimit;
        return n;
    },

    _isProduction: function() {
        var instanceName = (gs.getProperty('instance_name') || '').toLowerCase();
        var explicit = (gs.getProperty('x_operatorzero.environment') || '').toLowerCase();
        if (explicit === 'production' || explicit === 'prod') return true;
        if (explicit === 'dev' || explicit === 'test' || explicit === 'subprod') return false;
        return /(^|[-_.])prod([-_.]|$)|production|live/.test(instanceName);
    },

    _logDecision: function(action, params, decision) {
        gs.info('OperatorZero governance decision action=' + action +
            ' operation=' + (params.operation || '') +
            ' table=' + (params.table || '') +
            ' decision=' + decision.decision +
            ' reasons=' + decision.reasons.join(','));
    },

    _csv: function(value) {
        var out = {};
        var parts = (value || '').split(',');
        for (var i = 0; i < parts.length; i++) {
            var item = (parts[i] + '').replace(/^\s+|\s+$/g, '');
            if (item) out[item] = true;
        }
        return out;
    },

    _ok: function(result) {
        return {
            success: true,
            result: result
        };
    },

    _fail: function(error) {
        return {
            success: false,
            error: error
        };
    },

    type: 'OperatorZero_Governance_API'
};
