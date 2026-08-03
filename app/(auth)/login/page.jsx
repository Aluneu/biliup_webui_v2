'use client'

import React, {useState} from 'react';
import { Form, Checkbox, Button } from '@douyinfe/semi-ui';
import styles from './index.module.scss';
import getConfig from 'next/config';

// 演示站：纯假登录。
// 不做任何后端请求、不从响应里挖 token——点一下就写个固定会话标记并进入首页。
// 这样彻底不依赖"登录接口返回结构"，也不会因为某个 mock 接口异常而被弹回登录页。
const Component = () => {
    const [password, setPassword] = useState('');
    const [remember, setRemember] = useState(false);
    const [loading, setLoading] = useState(false);

    // 本地预览 basePath 为空；部署到 GitHub Pages 子路径时为 /<repo>
    const basePath = getConfig()?.basePath ?? '';

    const fakeLogin = (e) => {
        if (e && e.preventDefault) e.preventDefault();
        setLoading(true);
        // 写入模拟会话令牌（演示站靠 (app)/layout.tsx 守卫识别，只要存在即可）
        localStorage.setItem('biliup_token', 'demo');
        // 用 window.location.replace 硬跳转首页，避开静态导出 + trailingSlash 下的路由规范化死循环
        window.location.replace(`${basePath}/`);
    };

    return (
        <div className={styles.frame}>
            <div className={styles.main}>
                <div className={styles.login}>
                    <div className={styles.component66}>
                        <img
                            src={`${basePath}/logo.svg`}
                            className={styles.logo}
                            alt="logo"
                        />
                        <div className={styles.header}>
                            <p className={styles.title}>
                                欢迎回来
                            </p>
                            <p className={styles.text3}>
                                <span className={styles.text}>
                                    登录
                                </span>
                                <span className={styles.text2}>&nbsp;biliup&nbsp;</span>
                                <span className={styles.text}>账户</span>
                            </p>
                        </div>
                    </div>
                    <div className={styles.form}>
                        <Form className={styles.inputs}>
                            <Form.Input
                                label={{ text: "用户名" }}
                                field="username"
                                fieldStyle={{ padding: 0 }}
                                style={{ width: 440 }}
                                className={styles.formField}
                                initValue='biliup'
                                disabled
                            />
                            <Form.Input
                                label={{ text: "密码" }}
                                field="password"
                                type="password"
                                placeholder="输入密码"
                                fieldStyle={{ padding: 0 }}
                                style={{ width: 440 }}
                                className={styles.formField}
                                value={password}
                                onChange={setPassword}
                            />
                        </Form>
                        <Checkbox
                            type="default"
                            className={styles.checkbox}
                            checked={remember}
                            onChange={(e) => setRemember(e.target.checked)}
                        >
                            记住我
                        </Checkbox>
                        <Button
                            theme="solid"
                            block
                            loading={loading}
                            onClick={fakeLogin}
                        >
                            登录
                        </Button>
                    </div>
                    <div className={styles.demoHint}>
                        演示站 · 输入任意密码即可登录
                    </div>
                </div>
            </div>
        </div>
    );
}

export default Component;
