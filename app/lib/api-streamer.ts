// Fetcher implementation. // The extra argument will be passed via the `arg` property of the 2nd parameter.// In the example below, `arg` will be `'my_token'`

// 演示站：mock 模式下 patch window.fetch，拦截所有同源请求返回模拟数据
import { MOCK_ENABLED, installMockFetch } from './mock';

export const API_BASE = process.env.NEXT_PUBLIC_API_SERVER ?? '';

// 在浏览器端安装 mock 拦截（仅一次；无 window 时为预渲染，自动跳过）
if (MOCK_ENABLED) installMockFetch();
export async function sendRequest<T>(url: string, { arg }: { arg: T }) {
	const res = await fetch(API_BASE + url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(arg),
	});
	await handleResponse(res);
	return res.json();
}

export const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
	const res = await fetch(API_BASE + input, init);
	await handleResponse(res);
	return res.json();
};

export const proxy = async (input: RequestInfo | URL, init?: RequestInit) => {
	const res = await fetch(API_BASE + input, init);
	await handleResponse(res);
	return res;
};

export async function requestDelete<T>(url: string, { arg }: { arg: T }) {
	const res = await fetch(`${API_BASE}${url}/${arg}`, { method: 'DELETE' });
	await handleResponse(res);
	return res;
}

export async function put<T>(url: string, { arg }: { arg: T }) {
	const res = await fetch(`${API_BASE}${url}`, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(arg),
	});
	await handleResponse(res);
	return res;
}

async function handleResponse(res: Response) {
	// 演示站说明：本项目是 mock 假数据，没有真实鉴权概念。
	// 原版会在 401 时整页跳登录，但那在演示站里是隐患（任一接口异常都会把已登录用户弹回登录页），
	// 因此这里彻底移除 401 跳登录逻辑——只做普通错误抛出，绝不触发页面跳转。
	if (!res.ok) {
		// 尽量返回服务端错误信息
		const text = await res.text().catch(() => '');
		throw new Error(text || `HTTP ${res.status}`);
	}
	return res;
}

type Credit = {
	username: string;
	uid: number;
};

export interface StudioEntity {
	id: number;
	template_name: string;
	user_cookie: string;
	copyright: number;
	copyright_source: string;
	tid: number;
	cover_path: string;
	title: string;
	description: string;
	dynamic: string;
	tags: string[];
	dtime: number;
	// interactive: number;
	mission_id?: number;
	dolby: number;
	hires: number;
	no_reprint: number;
	is_only_self: number;
	up_selection_reply: number;
	up_close_reply: number;
	up_close_danmu: number;
	charging_pay: number;
	credits: Credit[];
	uploader: string;
	extra_fields?: string;
}

export interface LiveStreamerEntity {
	id: number;
	url: string;
	remark: string;
	filename: string;
	split_time?: number;
	split_size?: number;
	upload_id?: number;
	status?: string;
	upload_status?: string;
	statusTag?: React.ReactNode;
	format?: string;
    time_range?: string | Date[];
    excluded_keywords?: string[];
	preprocessor?: Record<'run', string>[];
	segment_processor?: Record<'run', string>[];
	downloaded_processor?: Record<'run', string>[];
	postprocessor?: (Record<'run' | 'mv', string> | 'rm')[];
	opt_args?: string[];
	override?: Record<string, any>;
}

export interface BiliType {
	id: number;
	children: BiliType[];
	name: string;
	desc: string;
}

export interface User {
	id: number;
	name: string;
	value: string;
	platform: string;
}

export interface FileList {
	key: number;
	name: string;
	updateTime: number;
	size: number;
}

export interface StreamerInfo {
	id: number;
	name: string;
	url: string;
	title: string;
	/** Unix 时间戳（秒），由后端 ts_seconds 序列化 */
	date: number;
	live_cover_path: string;
}

export interface BiliupStatus {
	downloader_status?: Record<string, string>;
	uploader_status?: Record<string, string>;
	config?: Record<string, any>;
}
