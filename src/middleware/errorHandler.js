import {ERROR_CODE} from "../constants.js";

const handler = (err, req, res, _) => {
    if (err.isOperational) {
        res.status(err.statusCode).json({message: err.message});
    } else {
        req.logger.error('Unexpected error:', err);
        res.status(ERROR_CODE.NOT_FOUND).json({message: 'Something went wrong'});
    }
}

export default handler;
