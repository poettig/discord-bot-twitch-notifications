import log from "loglevel"
import chalk from "chalk"
import prefix from "loglevel-plugin-prefix"
import strftime from "strftime"

const colors = {
	TRACE: chalk.magenta,
	DEBUG: chalk.cyan,
	INFO: chalk.blue,
	WARN: chalk.yellow,
	ERROR: chalk.red,
};

prefix.reg(log);
log.enableAll();

prefix.apply(log, {
	template: `${chalk.gray("[%t]")} %l ${chalk.green("%n:")}`,
	levelFormatter(level) {
		return colors[level.toUpperCase()](level.toUpperCase().padEnd(5, " "));
	},
	timestampFormatter(date) {
		return strftime("%Y-%m-%d %H:%M:%S", date);
	},
	nameFormatter(name) {
		let actualName = name || "root";
		return actualName.padStart(10, " ");
	}
});

export function createLogger(name, level) {
	let logger = log.getLogger(name);
	try {
		try {
			logger.setLevel(level);
		} catch {
			logger.setLevel(process.env.LEVEL);
		}
	} catch {
		logger.setLevel("warn");
	}
	return logger;
}