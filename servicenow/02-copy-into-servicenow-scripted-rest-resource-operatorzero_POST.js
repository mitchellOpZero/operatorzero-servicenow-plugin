/**
 * Scripted REST API resource for OperatorZero.
 *
 * Example endpoint:
 * POST /api/x_operatorzero/operatorzero
 */
(function process(/*RESTAPIRequest*/ request, /*RESTAPIResponse*/ response) {
    var params;

    try {
        params = request.body.data;
    } catch (e) {
        response.setStatus(400);
        response.setBody({
            success: false,
            error: 'Invalid request body. Expected JSON with an action field.'
        });
        return;
    }

    if (!params || !params.action) {
        response.setStatus(400);
        response.setBody({
            success: false,
            error: 'Missing required field: action'
        });
        return;
    }

    var api = new OperatorZero_Governance_API();
    var result = api.execute(params);

    if (!result || result.success !== true) {
        response.setStatus(result && result.blocked ? 403 : 500);
        response.setBody(result || {
            success: false,
            error: 'No result returned by OperatorZero_Governance_API'
        });
        return;
    }

    response.setStatus(200);
    response.setBody(result);
})(request, response);

